import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  type WASocket,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { recordIncoming, generateParticipation, maybeUpdateNotes } from "./agent.js";
import { readingDelay, typingDuration, spontaneousQuestionChance, SPONTANEOUS_QUESTIONS, canReplyNow, markReplied, isSleepHours } from "./behavior.js";
import { BOT_NAME, SPONTANEOUS_LEVEL } from "./config.js";
import { transcribeAudio } from "./transcribe.js";
import { synthesizeVoice } from "./tts.js";

const logger = pino({ level: "silent" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sock: WASocket;

// Debounce de ráfagas: si llegan varios mensajes seguidos, solo responde al ÚLTIMO
// (como un humano que lee todo y contesta una vez, no mensaje por mensaje)
type PendingMsg = {
  msg: BaileysEventMap["messages.upsert"]["messages"][number];
  senderName: string;
  text: string;
  isAudio: boolean;
  quoted?: { name: string; text: string };
};
const pending = new Map<string, NodeJS.Timeout>();
const lastMsg = new Map<string, PendingMsg>();
const lastReplyAt = new Map<string, number>();
// Última actividad por grupo: para que las preguntas espontáneas no se boten al vacío
const lastActivityAt = new Map<string, number>();

function isGroup(jid: string): boolean {
  return jid.endsWith("@g.us");
}

// Cache de nombres de grupos (JID -> asunto) para poder filtrar por nombre
const groupNames = new Map<string, string>();

async function refreshGroupNames(): Promise<void> {
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [jid, meta] of Object.entries(groups)) {
      groupNames.set(jid, meta.subject ?? "");
    }
    console.log(`📋 Grupos: ${[...groupNames.values()].map((n) => `"${n}"`).join(", ")}`);
  } catch (e) {
    console.error("No pude traer los grupos:", e);
  }
}

function allowed(groupJid: string): boolean {
  const list = (process.env.ALLOWED_GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return false;
  const name = groupNames.get(groupJid) ?? "";
  return list.some((g) => g === groupJid || name.toLowerCase().includes(g.toLowerCase()));
}

// Grupos en modo lurker: el bot los lee y arma contexto (memoria + notas de gente),
// pero nunca habla. Para activarlo en un grupo: pasar el nombre a ALLOWED_GROUPS.
function silent(groupJid: string): boolean {
  const list = (process.env.SILENT_GROUPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return false;
  const name = groupNames.get(groupJid) ?? "";
  return list.some((g) => g === groupJid || name.toLowerCase().includes(g.toLowerCase()));
}

async function start(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    // Perfil: nombre que ve el grupo
    browser: ["Chrome (Linux)", "", ""],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n📲 Escaneá este QR con WhatsApp (Dispositivos vinculados):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log(`✅ ${BOT_NAME} conectado. Escuchando grupos...`);
      void refreshGroupNames();
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const reconn = code !== DisconnectReason.loggedOut;
      console.log(reconn ? "🔄 Reconectando..." : "❌ Sesión cerrada. Borrá auth_info y reescaneá.");
      if (reconn) setTimeout(start, 3_000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }: BaileysEventMap["messages.upsert"]) => {
    if (type !== "notify") return;
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe || !msg.key.remoteJid) return;
    const jid = msg.key.remoteJid;
    if (!isGroup(jid) || !groupNames.has(jid)) await refreshGroupNames();
    // Entran mensajes de grupos permitidos Y de grupos en modo lurker (solo escucha)
    if (!isGroup(jid) || (!allowed(jid) && !silent(jid))) return;

    const isAudio = !!msg.message.audioMessage;
    const senderName =
      msg.pushName || msg.key.participant?.split("@")[0] || "alguien";
    let text =
      msg.message.conversation ??
      msg.message.extendedTextMessage?.text ??
      "";

    // Audios: descargar y transcribir (como un humano que le da play)
    if (!text.trim() && isAudio) {
      console.log(`[grupo] ${senderName}: 🎤 audio`);
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
        const transcript = buffer ? await transcribeAudio(buffer as Buffer) : "";
        if (transcript) {
          text = `(audio) ${transcript}`;
          console.log(`       ↳ transcripción: ${transcript.slice(0, 100)}`);
        } else {
          console.log("       ↳ no se pudo transcribir");
        }
      } catch (e) {
        console.log("       ↳ error descargando audio:", (e as Error).message?.slice(0, 80));
      }
    }

    if (!text.trim()) return;

    // Contexto de cita: si responde citando otro mensaje, extraer a qué respondía
    const ctxInfo = msg.message.extendedTextMessage?.contextInfo;
    const quotedMsg = ctxInfo?.quotedMessage;
    const quotedText =
      quotedMsg?.conversation ??
      quotedMsg?.extendedTextMessage?.text ?? "";
    const quoted =
      quotedText.trim() && ctxInfo?.participant
        ? {
            name: groupNames.get(ctxInfo.participant.split("@")[0] + "@s.whatsapp.net") ?? ctxInfo.participant.split("@")[0],
            text: quotedText.trim().slice(0, 200),
          }
        : undefined;

    const ts = new Date(Number(msg.messageTimestamp || 0) * 1000).toLocaleTimeString("es-AR");
    console.log(`\n[${ts}] ${senderName}: ${text.slice(0, 150)}`);
    recordIncoming(jid, senderName, text);
    void maybeUpdateNotes(jid);

    // Guardar como último mensaje y (re)agendar respuesta: si llega otro antes,
    // este queda como "ya leído" y el nuevo dispara la respuesta
    lastMsg.set(jid, { msg, senderName, text, isAudio, quoted });
    lastActivityAt.set(jid, Date.now());
    const prev = pending.get(jid);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      pending.delete(jid);
      void respondToLast(jid);
    }, 8_000 + Math.random() * 12_000);
    pending.set(jid, timer);
  });

  async function respondToLast(jid: string): Promise<void> {
    const m = lastMsg.get(jid);
    if (!m || !sock) return;
    const { msg, senderName, text, isAudio, quoted } = m;

    // Modo lurker (grupo en SILENT_GROUPS y no en ALLOWED_GROUPS): graba la
    // conversación (los audios ya llegan transcriptos) y destila notas de gente,
    // pero JAMÁS responde. ALLOWED_GROUPS tiene prioridad si el grupo está en ambas.
    if (silent(jid) && !allowed(jid)) {
      recordIncoming(jid, senderName, text);
      void maybeUpdateNotes(jid); // fire-and-forget, se autolimita (~cada 20 msgs)
      console.log("       👂 (modo lurker: leyó y guardó, no habla)");
      return;
    }

    // Cooldown: un humano no contesta 2 veces en 30 segundos
    if (!canReplyNow(jid)) {
      console.log("       ↳ (ya contestó hace un rato, deja pasar)");
      return;
    }

    // Horario de sueño: casi siempre dormido (BOT_OFFLINE_HOURS en .env)
    if (isSleepHours() && Math.random() < 0.85) {
      console.log("       ↳ (durmiendo 🛏)");
      return;
    }

    const delay = readingDelay(text) * (isSleepHours() ? 2 : 1);
    await sleep(delay);

    try {
      // Decisión razonada de participación + respuesta en UNA llamada LLM
      // (arquitectura Captain: structured output). El azar ya no decide nada.
      const decision = await generateParticipation(jid, senderName, text, quoted);

      // Anti-carrera (arquitectura Captain): si llegó un mensaje más nuevo
      // mientras generábamos, esta respuesta queda vieja — se descarta
      if (lastMsg.get(jid) !== m) {
        console.log("       ↳ (llegó mensaje más nuevo mientras generaba — descarto esta respuesta)");
        return;
      }

      // Decidió callarse: siguió su vida (a veces reacciona con emoji — 100% humano)
      if (!decision.responder || !decision.texto) {
        console.log(`       ↳ (leyó, no contesta — ${decision.razon || "sin razón"})`);
        if (!isAudio && Math.random() < 0.15) {
          const emojis = ["👍", "😂", "🤣", "🗿", "🤔"];
          const emoji = emojis[Math.floor(Math.random() * emojis.length)];
          try {
            await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
            console.log(`       ↳ reaccionó con ${emoji}`);
          } catch { /* la reacción es best-effort */ }
        }
        return;
      }

      let reply = decision.texto;

      // ¿Pidió nota de voz? ([audio] <texto>)
      if (reply.startsWith("[audio]")) {
        const spoken = reply.slice("[audio]".length).trim();
        // "escribiendo..." mientras sintetiza (sintetizar demora)
        await sock.sendPresenceUpdate("composing", jid);
        const ogg = await synthesizeVoice(spoken);
        if (ogg) {
          await sleep(1_500 + Math.random() * 2_000); // delay corto: los audios salen rápido
          await sock.sendPresenceUpdate("paused", jid);
          await sock.sendMessage(jid, {
            audio: ogg,
            ptt: true,
            mimetype: "audio/ogg; codecs=opus",
          });
          console.log(`[bot] 🎙 nota de voz enviada (~${Math.max(2, Math.round(spoken.length / 14))}s)`);
          markReplied(jid);
          return;
        }
        console.log("[bot] TTS falló — mando texto");
        reply = spoken; // nunca quedarse sin responder
      }


      // Chunking: a veces parte la respuesta en 2 mensajes, como un humano
      const splitMatch = /^(.{20,}?[?!.])\s+(.{15,})$/s.exec(reply);
      if (splitMatch && Math.random() < 0.35) {
        const [first, second] = [splitMatch[1], splitMatch[2]];
        const shouldQuote = !!msg.key?.participant && Math.random() < 0.5;
        await sock.sendMessage(jid, { text: first }, shouldQuote ? { quoted: msg } : undefined);
        console.log(`\n[${new Date().toLocaleTimeString("es-AR")}] ${BOT_NAME}: ${first} (1/2)`);
        await sock.sendPresenceUpdate("composing", jid);
        await sleep(2_500 + Math.random() * 4_000);
        await sock.sendPresenceUpdate("paused", jid);
        await sock.sendMessage(jid, { text: second });
        console.log(`[${new Date().toLocaleTimeString("es-AR")}] ${BOT_NAME}: ${second} (2/2)`);
        markReplied(jid);
        return;
      }

      // Tipeo humanizado: arranca, corta un rato ("se distrajo"), vuelve, manda.
      const total = typingDuration(reply);
      await sock.sendPresenceUpdate("composing", jid);
      await sleep(total * 0.6);
      if (Math.random() < 0.35) {
        // pausa natural: lo interrumpieron, fue al baño, etc.
        await sock.sendPresenceUpdate("paused", jid);
        await sleep(2_000 + Math.random() * 8_000);
        await sock.sendPresenceUpdate("composing", jid);
      }
      await sleep(total * 0.4);
      await sock.sendPresenceUpdate("paused", jid);

      // Responder citando el mensaje original (como el botón "responder" de WhatsApp).
      // Un humano no cita siempre: ~50% de las veces responde suelto.
      const shouldQuote = !!msg.key?.participant && Math.random() < 0.5;
      await sock.sendMessage(jid, { text: reply }, shouldQuote ? { quoted: msg } : undefined);

      const ts2 = new Date().toLocaleTimeString("es-AR");
      console.log(`\n[${ts2}] ${BOT_NAME}: ${reply}${shouldQuote ? "  (respondió citando)" : ""}`);
      markReplied(jid);
    } catch (err) {
      console.error("Error generando respuesta:", err);
    }
  }

  // Preguntas espontáneas (troll): de vez en cuando bota algo sin que nadie hable
  setInterval(async () => {
    if (!sock?.user || Math.random() > spontaneousQuestionChance()) return;
    // En sueños no manda preguntas (como todos)
    if (isSleepHours()) return;
    const groupJid = (process.env.ALLOWED_GROUPS ?? "").split(",")[0].trim();
    if (!groupJid) return;
    // Si el grupo está muerto hace 30 min, no bota preguntas al vacío
    const lastAct = lastActivityAt.get(groupJid);
    if (!lastAct || Date.now() - lastAct > 30 * 60_000) return;
    const q = SPONTANEOUS_QUESTIONS[Math.floor(Math.random() * SPONTANEOUS_QUESTIONS.length)];
    await sock.sendPresenceUpdate("composing", groupJid);
    await sleep(2_000);
    await sock.sendPresenceUpdate("paused", groupJid);
    await sock.sendMessage(groupJid, { text: q });
    recordIncoming(groupJid, BOT_NAME, q);
    console.log(`[bot][espontáneo] ${q}`);
  }, 20 * 60 * 1000); // chequeo periódico; desactivado por defecto
}

console.log(`🤖 ${BOT_NAME} — nivel de mensajes espontáneos: ${SPONTANEOUS_LEVEL}`);
start().catch(console.error);
