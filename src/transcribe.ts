import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Transcripción de audios de WhatsApp, 100% local:
 * ogg/opus → wav 16k mono con ffmpeg → whisper-cli (--language es)
 * Sin APIs externas, sin cuotas.
 */

const WHISPER_BIN =
  process.env.WHISPER_BIN?.trim() || path.resolve("tools/whisper/bin/Release/whisper-cli.exe");
const WHISPER_MODEL =
  process.env.WHISPER_MODEL?.trim() || path.resolve("tools/models/ggml-small.bin");
const CACHE_DIR = path.resolve("tools/cache/audio");
const TIMEOUT_MS = 60_000;

/** Ejecuta un proceso capturando stdout/stderr, con timeout. */
function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        resolve({ code: -1, stdout, stderr: stderr + "\n[timeout]" });
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + e.message });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Resolve ffmpeg from an explicit path or the system PATH. */
let ffmpegPath: string | null = null;
export function resolveFFmpeg(): string {
  if (ffmpegPath) return ffmpegPath;
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    ffmpegPath = process.env.FFMPEG_PATH;
    return ffmpegPath;
  }
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
  } catch {
    console.warn("[bot] ffmpeg no está instalado o no figura en PATH.");
  }
  ffmpegPath = "ffmpeg";
  return ffmpegPath;
}
/** Convierte ogg/opus a wav 16kHz mono. Devuelve el path del wav o null. */
async function toWav(hash: string, oggPath: string): Promise<string | null> {
  const wavPath = path.join(CACHE_DIR, `${hash}.wav`);
  if (existsSync(wavPath) && statSync(wavPath).size > 1000) return wavPath;
  const r = await run(resolveFFmpeg(), ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", wavPath], TIMEOUT_MS);
  if (r.code !== 0 || !existsSync(wavPath)) {
    console.log("[bot] ffmpeg falló:", r.stderr.slice(-120));
    return null;
  }
  return wavPath;
}

/** Limpia la salida de whisper-cli (quita timestamps si los hay). */
function cleanWhisperOutput(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((l) => l.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, "").trim())
    .filter(Boolean);
  return lines.join(" ").trim();
}

/** Transcripción local con whisper.cpp. Devuelve "" si falla, texto si ok. */
async function transcribeLocal(buffer: Buffer): Promise<string> {
  if (!existsSync(WHISPER_BIN) || !existsSync(WHISPER_MODEL)) {
    console.log("[bot] whisper.cpp no instalado; audio sin transcribir");
    return "";
  }
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  await mkdir(CACHE_DIR, { recursive: true });
  const oggPath = path.join(CACHE_DIR, `${hash}.ogg`);
  await writeFile(oggPath, buffer);

  const wavPath = await toWav(hash, oggPath);
  if (!wavPath) return "";

  const r = await run(
    WHISPER_BIN,
    ["-m", WHISPER_MODEL, "-l", "es", "-nt", "--no-prints", wavPath],
    TIMEOUT_MS,
  );
  if (r.code !== 0) {
    console.log("[bot] whisper-cli falló:", (r.stderr || r.stdout).slice(-120));
    return "";
  }
  const text = cleanWhisperOutput(r.stdout);
  return text;
}

/** Cache en memoria de transcripciones ya hechas (mismo audio → misma respuesta). */
const memo = new Map<string, string>();

/**
 * Transcribe un audio de WhatsApp con whisper.cpp local.
 * Devuelve la transcripción o "" si falla (el audio simplemente "no lo escuchó").
 */
export async function transcribeAudio(buffer: Buffer): Promise<string> {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  const cached = memo.get(hash);
  if (cached !== undefined) return cached;

  const text = await transcribeLocal(buffer);
  if (text) console.log("[bot] transcripción local ok");
  memo.set(hash, text);
  return text;
}

// Export interno para pruebas manuales (scripts/test-transcribe.ts)
export async function transcribeFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return transcribeAudio(buffer);
}
