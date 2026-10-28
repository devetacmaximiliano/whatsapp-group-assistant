import { spawn } from "node:child_process";
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "dotenv/config";
import { resolveFFmpeg } from "./transcribe.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PCM_SAMPLE_RATE = 24_000; // gpt-audio output: 24kHz mono 16-bit

function run(cmd: string[], timeoutMs: number, quiet = true): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { windowsHide: true });
    let done = false;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        resolve({ code: -1, stderr: stderr + "[timeout]" });
      }
    }, timeoutMs);
    child.on("error", (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ code: -1, stderr: stderr + e.message });
      }
    });
    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        if (!quiet && code !== 0) console.log("[bot] stderr:", stderr.slice(-200));
        resolve({ code: code ?? -1, stderr });
      }
    });
  });
}

async function toOggOpus(inputPath: string, outPath: string): Promise<boolean> {
  // Cadena "grabado con el celular": saca el aire de estudio del TTS
  // (highpass/lowpass = mic de teléfono, acompressor = compresión de voz,
  //  anoisesrc = ruido de fondo rosa sutil, silenceremove = recorta aire)
  const r = await run(
    [
      resolveFFmpeg(),
      "-y", "-i", inputPath,
      "-f", "lavfi", "-i", "anoisesrc=colour=pink:amplitude=0.008:duration=60",
      "-filter_complex",
      "[0:a]silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.25,areverse,highpass=f=95,lowpass=f=7800,acompressor=threshold=-22dB:ratio=3:attack=20:release=220,volume=0.88[m];[1:a]atrim=0:60,volume=0.008[n];[m][n]amix=inputs=2:duration=first[aout]",
      "-map", "[aout]",
      "-c:a", "libopus", "-b:a", "24k", "-ar", "48000", "-ac", "1",
      outPath,
    ],
    30_000,
  );
  return r.code === 0;
}

/**
 * Pre-procesa el texto para que suene humano: pausas naturales ("...")
 * donde la prosodia del TTS es demasiado plana.
 */
function addPauses(text: string): string {
  // "che" suelto al inicio → pausa después
  let out = text.replace(/^che\b\s*/i, "che... ");
  // comas → pausa audible en ~40% de los casos (aleatorio por coma para no sonar mecánico)
  out = out.replace(/,\s+/g, () => (Math.random() < 0.4 ? "... " : ", "));
  // "jajaja" al final no hace falta decirlo entero: lo corta natural el tono
  return out;
}

/**
 * TTS primario: edge-tts con una voz neural configurada.
 * Gratis, sin API key, acento argentino real.
 * Params afinados según la comunidad: rate negativo (más lento = más natural),
 * pitch levemente bajo (suena menos locutor).
 */
async function synthesizeEdge(text: string, dir: string): Promise<Buffer | null> {
  const voice = process.env.TTS_EDGE_VOICE ?? "es-AR-ElenaNeural";
  const rate = process.env.TTS_EDGE_RATE ?? "-10%";
  const pitch = process.env.TTS_EDGE_PITCH ?? "-3Hz";
  const mp3Path = path.join(dir, "edge.mp3");

  const spoken = addPauses(text);

  // Texto→voz por CLI de edge-tts (paquete pip).
  const r = await run(
    [
      "python", "-m", "edge_tts",
      "--voice", voice,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      "--text", spoken,
      "--write-media", mp3Path,
    ],
    30_000,
  );
  if (r.code !== 0 || !existsSync(mp3Path) || statSync(mp3Path).size < 1000) return null;

  const oggPath = path.join(dir, "edge.ogg");
  const ok = await toOggOpus(mp3Path, oggPath);
  if (!ok) return null;
  const ogg = await readFile(oggPath);
  return ogg.length > 500 ? ogg : null;
}

function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * TTS fallback: OpenRouter chat completions con modalidad audio
 * (streaming pcm16). Voz genérica, menos "argenta" que edge-tts.
 */
async function synthesizeOpenRouter(text: string, dir: string): Promise<Buffer | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = process.env.TTS_MODEL ?? "openai/gpt-audio-mini";
  const voice = process.env.TTS_VOICE ?? "onyx";

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "whatsapp-group-assistant",
      },
      body: JSON.stringify({
        model,
        modalities: ["text", "audio"],
        audio: { voice, format: "pcm16" },
        stream: true,
        messages: [
          {
            role: "user",
            content: `Decí EXACTAMENTE este texto, sin agregar ni cambiar nada, con tono casual de pibe argentino de 18: "${text}"`,
          },
        ],
      }),
    });

    if (!res.ok || !res.body) {
      console.log(`[bot] TTS OpenRouter falló (${res.status})`);
      return null;
    }

    let audioB64 = "";
    const lines = (await res.text()).split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") continue;
      try {
        const data = JSON.parse(line.slice(6)) as {
          choices?: { delta?: { audio?: { data?: string } } }[];
        };
        const chunk = data.choices?.[0]?.delta?.audio?.data;
        if (chunk) audioB64 += chunk;
      } catch {
        /* línea no-JSON (heartbeat), ignorar */
      }
    }
    if (!audioB64) return null;

    const pcm = Buffer.from(audioB64, "base64");
    if (pcm.length < 1000) return null;

    const wavPath = path.join(dir, "or.wav");
    await writeFile(wavPath, pcmToWav(pcm));
    const oggPath = path.join(dir, "or.ogg");
    const ok = await toOggOpus(wavPath, oggPath);
    if (!ok) return null;
    const ogg = await readFile(oggPath);
    return ogg.length > 500 ? ogg : null;
  } catch (err) {
    console.log("[bot] TTS OpenRouter error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Límite diario de uso de ElevenLabs (protege el tier free de 10k chars/mes). */
function elevenDailyQuota(): { allowed: boolean; count: number } {
  try {
    const file = "data/eleven_usage.json";
    const today = new Date().toISOString().slice(0, 10);
    const state = JSON.parse(readFileSync(file, "utf8")) as { date: string; count: number };
    const count = state.date === today ? state.count : 0;
    const max = Number(process.env.ELEVEN_DAILY_MAX ?? 60);
    return { allowed: count < max, count };
  } catch {
    return { allowed: true, count: 0 };
  }
}

function elevenTrackUsage(chars: number): void {
  try {
    mkdirSync("data", { recursive: true });
    const file = "data/eleven_usage.json";
    const today = new Date().toISOString().slice(0, 10);
    let state = { date: today, count: 0 };
    try {
      const prev = JSON.parse(readFileSync(file, "utf8")) as { date: string; count: number };
      if (prev.date === today) state.count = prev.count;
    } catch { /* primer uso del día */ }
    state.count += chars;
    writeFileSync(file, JSON.stringify(state));
  } catch { /* best-effort */ }
}

/**
 * TTS premium: ElevenLabs (eleven_flash_v2_5 multilingual).
 * SOLO para textos cortos (notas de voz breves) — protege el tier free.
 * Devuelve mp3 buffer o null.
 */
async function synthesizeElevenLabs(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const maxChars = Number(process.env.ELEVEN_MAX_CHARS ?? 160);
  if (text.length > maxChars) {
    console.log(`[bot] texto muy largo para ElevenLabs (${text.length} > ${maxChars}) — uso edge`);
    return null;
  }
  const quota = elevenDailyQuota();
  if (!quota.allowed) {
    console.log(`[bot] cuota diaria ElevenLabs agotada (${quota.count}) — uso edge`);
    return null;
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "pNInz6obpgDQGcFmaJgB"; // Adam
  const model = process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5";

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        language_code: "es",
        voice_settings: {
          stability: 0.45,          // algo de variación = menos robótico
          similarity_boost: 0.75,
          style: 0.35,              // expresividad casual
          use_speaker_boost: true,
        },
      }),
    });

    if (!res.ok) {
      console.log(`[bot] ElevenLabs falló (${res.status}):`, (await res.text()).slice(0, 120));
      return null;
    }

    const mp3 = Buffer.from(await res.arrayBuffer());
    if (mp3.length < 1000) return null;
    elevenTrackUsage(text.length);
    console.log(`[bot] ElevenLabs: ${text.length} chars (uso de hoy: ${elevenDailyQuota().count})`);
    return mp3;
  } catch (err) {
    console.log("[bot] ElevenLabs error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * TTS con voces reales: Fish Audio (marketplace fish.audio/explore).
 * reference_id = id del modelo de voz pública elegido del marketplace.
 * Modelo default s2.1-pro-free: GRATIS ($0/M bytes), no requiere crédito API.
 * Modelos pagos (s2.1-pro, drama-3) requieren crédito en fish.audio/app/developers.
 * Devuelve mp3 buffer o null.
 */
async function synthesizeFishAudio(text: string): Promise<Buffer | null> {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  const voiceId = process.env.FISH_AUDIO_VOICE_ID;
  if (!apiKey || !voiceId) return null;

  const maxChars = Number(process.env.FISH_MAX_CHARS ?? 400);
  if (text.length > maxChars) {
    console.log(`[bot] texto muy largo para Fish Audio (${text.length} > ${maxChars})`);
    return null;
  }

  try {
    const res = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // s2.1-pro-free = gratis; s2.1-pro/drama-3 = mejor calidad, requiere crédito
        model: process.env.FISH_TTS_MODEL ?? "s2.1-pro-free",
      },
      body: JSON.stringify({
        text,
        reference_id: voiceId,
        format: "mp3",
        mp3_bitrate: 64,
        chunk_length: 200,
        normalize: true,
        latency: "normal",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      const hint =
        res.status === 402 && (process.env.FISH_TTS_MODEL ?? "s2.1-pro-free") !== "s2.1-pro-free"
          ? " — modelo pago: cargar crédito en https://fish.audio/app/developers"
          : "";
      console.log(`[bot] Fish Audio falló (${res.status}): ${body.slice(0, 140)}${hint}`);
      return null;
    }

    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("audio") && !ct.includes("octet-stream")) {
      console.log(`[bot] Fish Audio: respuesta no-audio (${ct})`);
      return null;
    }

    const mp3 = Buffer.from(await res.arrayBuffer());
    if (mp3.length < 1000) return null;
    console.log(`[bot] Fish Audio: ${text.length} chars (modelo ${process.env.FISH_TTS_MODEL ?? "s2.1-pro-free"})`);
    return mp3;
  } catch (err) {
    console.log("[bot] Fish Audio error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** mp3 → ogg/opus con la cadena de filtro "grabado con el celular". */
async function mp3ToOgg(mp3: Buffer, dir: string, name: string): Promise<Buffer | null> {
  const mp3Path = path.join(dir, `${name}.mp3`);
  await writeFile(mp3Path, mp3);
  const oggPath = path.join(dir, `${name}.ogg`);
  if (!(await toOggOpus(mp3Path, oggPath))) return null;
  const ogg = await readFile(oggPath);
  return ogg.length > 500 ? ogg : null;
}

/**
 * Sintetiza una nota de voz: Fish Audio (voz real del marketplace) primero,
 * ElevenLabs (premium, solo cortos), edge-tts es-AR de confianza, OpenRouter al final.
 * Devuelve ogg/opus o null si todo falla.
 */
export async function synthesizeVoice(text: string): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "whatsapp-assistant-tts-"));
  try {
    // 0) Fish Audio (mp3) → convertir a ogg
    const fishMp3 = await synthesizeFishAudio(text);
    if (fishMp3) {
      const ogg = await mp3ToOgg(fishMp3, dir, "fish");
      if (ogg) return ogg;
    }

    // 1) ElevenLabs (mp3) → convertir a ogg
    const elMp3 = await synthesizeElevenLabs(text);
    if (elMp3) {
      const ogg = await mp3ToOgg(elMp3, dir, "el");
      if (ogg) return ogg;
    }

    // 2) edge-tts → OpenRouter
    const ogg =
      (await synthesizeEdge(text, dir)) ?? (await synthesizeOpenRouter(text, dir));
    return ogg;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
