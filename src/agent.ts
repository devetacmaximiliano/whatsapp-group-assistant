import { getMemory, pushMemory, type Msg } from "./memory.js";
import { buildSystemPrompt, untrustedWrapper } from "./prompts.js";
import { callOpenRouter, callOpenRouterRaw, sanitizeReply } from "./openrouter.js";
import { getNotes, getAllNotes, saveNotes, countMessages } from "./db.js";
import { isDirectMention } from "./behavior.js";
import { BOT_NAME, ENABLE_USER_NOTES } from "./config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const buildSystem = buildSystemPrompt;

/**
 * Ventana de contexto:
 * - Solo mensajes de las últimas ~2 horas (después, "no escuchaba")
 * - Máximo 12 mensajes: los humanos siguen los ÚLTIMOS turnos, no todo el día
 * - Presupuesto de ~4000 caracteres
 * - Timestamps relativos para que el LLM sepa el ritmo de la conversación
 */
function buildTranscript(history: Msg[]): string {
  const now = Date.now();
  const WINDOW_MS = 2 * 60 * 60 * 1000; // 2 horas

  const recent = history.filter((m) => now - m.ts < WINDOW_MS);
  const window = recent.slice(-12);

  // Presupuesto de caracteres: recortar de los más viejos
  let budget = 4000;
  const kept: string[] = [];
  for (let i = window.length - 1; i >= 0; i--) {
    const m = window[i];
    const mins = Math.round((now - m.ts) / 60_000);
    const timeTag = mins < 2 ? "ahora" : mins < 60 ? `hace ${mins} min` : `hace ${Math.round(mins / 60)} h`;
    // Marcador de episodio (arquitectura Captain): si paso un rato largo entre
    // mensajes, el LLM entiende que lo anterior es OTRO episodio ya cerrado
    const prev = window[i + 1];
    if (prev && m.ts - prev.ts > 30 * 60 * 1000) {
      const gapMins = Math.round((m.ts - prev.ts) / 60_000);
      const gapLabel = gapMins >= 60 ? `${Math.round(gapMins / 60)} h` : `${gapMins} min`;
      const marker = `--- (paso un rato: ${gapLabel} sin mensajes — tema nuevo probablemente) ---`;
      if (marker.length <= budget) {
        budget -= marker.length + 1;
        kept.unshift(marker);
      }
    }
    const line = `[${timeTag}] ${m.name}: ${m.text}`;
    if (line.length > budget) break;
    budget -= line.length + 1;
    kept.unshift(line);
  }

  return kept.length ? kept.join("\n") : "(no escuchó nada del grupo en un rato)";
}

function buildUser(
  transcript: string,
  senderName: string,
  text: string,
  participationCtx: string,
  directMention: boolean,
): string {
  const directCtx = directMention
    ? `Te mencionaron, te citaron o te hicieron una pregunta directa. Responde si puedes aportar algo útil.\n\n`
    : "";
  return (
    untrustedWrapper(
      `Mensajes recientes del grupo de WhatsApp; las marcas de tiempo indican cuándo llegó cada mensaje:\n\n${transcript}`,
      "transcripcion_grupo",
    ) +
    `\n\nMensaje nuevo de "${senderName}": ${text}\n\n` +
    directCtx +
    participationCtx +
    `Responde como ${BOT_NAME}. Sé breve, cordial y claro. Usa solo información disponible en la conversación o fuentes configuradas. No inventes datos ni experiencias personales; si algo no está claro, dilo o pide una aclaración. Identifícate como asistente automatizado cuando te pregunten. Usa [audio] solo ante una solicitud explícita de nota de voz.`
  );
}
/** Decisión de participación + respuesta en un solo pase (arquitectura Captain:
 * structured output con reasoning interno). */
export type Participation = { responder: boolean; razon: string; texto: string };

/**
 * Estado reciente de participación del asistente en la conversación: hace cuánto
 * habló y cuántos mensajes corrieron desde entonces. Es el dato clave para
 * que decida si entra (nadie que recién habló vuelve a hablar sin que lo llamen).
 */
function buildParticipationCtx(history: Msg[]): string {
  const now = Date.now();
  const WINDOW_MS = 2 * 60 * 60 * 1000; // misma ventana que el transcript
  const recent = history.filter((m) => now - m.ts < WINDOW_MS);
  const lastOwnIdx = recent.map((m) => m.name === BOT_NAME).lastIndexOf(true);
  if (lastOwnIdx < 0) return `Eres ${BOT_NAME}. Todavía no has respondido en este periodo.\n\n`;
  const mins = Math.max(1, Math.round((now - recent[lastOwnIdx].ts) / 60_000));
  const since = recent.length - 1 - lastOwnIdx;
  return (
    `Eres ${BOT_NAME}. Respondiste hace ${mins} min; desde entonces llegaron ${since} mensajes.\n\n`
  );
}

/**
 * Parseo tolerante de la decisión JSON: los modelos free a veces meten fences
 * ```json, texto alrededor o rompen el schema — se recupera lo que se pueda.
 */
function parseParticipation(raw: string): Participation | null {
  // Fences ```json ... ``` → fuera backticks antes de buscar el objeto
  const cleaned = raw.replace(/```(?:json)?/gi, "");
  const m = /\{[\s\S]*\}/.exec(cleaned);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { responder?: unknown; razon?: unknown; texto?: unknown };
    if (typeof j.responder !== "boolean") return null;
    const texto = typeof j.texto === "string" ? j.texto.trim() : "";
    const razon = typeof j.razon === "string" ? j.razon.slice(0, 120) : "";
    if (j.responder && !texto) return null; // dice que responde pero no trae texto
    return { responder: j.responder, razon, texto };
  } catch {
    return null;
  }
}

export async function generateParticipation(groupJid: string, senderName: string, text: string, quoted?: { name: string; text: string }): Promise<Participation> {
  const history: Msg[] = getMemory(groupJid);
  const transcript = buildTranscript(history);

  const system = buildSystem();
  const quotedCtx = quoted
    ? `ATENCIÓN: "${senderName}" está respondiendo (citando) el mensaje de "${quoted.name}": "${quoted.text}". Tu respuesta va dirigida a eso. TE CITARON DIRECTAMENTE: respondé salvo que sea excepcional no hacerlo.\n\n`
    : "";

  // Anti-repetición: los últimos mensajes de ${BOT_NAME} (para no usar siempre el mismo arranque)
  const own = history
    .filter((m) => m.name === BOT_NAME)
    .slice(-3)
    .map((m) => `- ${m.text}`)
    .join("\n");
  const ownCtx = own
    ? `Tus últimos mensajes en el grupo (NO te repitas, no uses las mismas palabras de arranque ni el mismo chiste):\n${own}\n\n`
    : "";

  // Memoria por persona: lo que ${BOT_NAME} ya "sabe" de la gente activa en la transcripción
  const names = [...new Set(history.slice(-12).map((m) => m.name))];
  const notes = names
    .map((n) => {
      const nt = getNotes(groupJid, n);
      return nt ? `- ${n}: ${nt}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const notesCtx = notes
    ? `Lo que ya sabés de la gente (no lo redigas, ya lo sabés, usalo natural si aplica):\n${notes}\n\n`
    : "";

  const user =
    quotedCtx + notesCtx + ownCtx +
    buildUser(transcript, senderName, text, buildParticipationCtx(history), isDirectMention(text, quoted));

  // 1) Principal: NVIDIA Nemotron vía OpenRouter (gratis). Variante RAW: la
  // decisión válida ES un JSON (sanitizeReply lo mataría); el texto visible
  // se sanitiza aparte más abajo, en ambos caminos
  let raw = "";
  if (process.env.OPENROUTER_API_KEY) {
    raw = await callOpenRouterRaw(system, user);
  }

  // 2) Decisión estructurada; si el modelo no cumplió el JSON, fallback al
  // comportamiento viejo (texto plano → responde si sobrevive al sanitizado)
  let decision: Participation | null = raw ? parseParticipation(raw) : null;
  if (!decision) {
    const clean = raw ? sanitizeReply(raw) : "";
    decision = clean
      ? { responder: true, razon: "fallback texto plano", texto: clean }
      : { responder: false, razon: "sin respuesta utilizable", texto: "" };
  } else if (decision.responder) {
    const clean = sanitizeReply(decision.texto);
    decision = clean
      ? { ...decision, texto: clean }
      : { responder: false, razon: "respuesta inservible", texto: "" };
  }

  console.log(`[bot] decisión: ${decision.responder ? "responde" : "callado"} — ${decision.razon || "sin razón"}`);

  // Solo queda en memoria lo que efectivamente dijo (si calló, no registra nada)
  if (decision.responder && decision.texto) {
    pushMemory(groupJid, { name: BOT_NAME, text: decision.texto, ts: Date.now() });
  }
  return decision;
}

export function recordIncoming(groupJid: string, name: string, text: string): void {
  pushMemory(groupJid, { name, text, ts: Date.now() });
}

/**
 * Cada ~20 mensajes: el LLM resume datos dignos de memoria sobre cada persona
 * (apodos, qué hace, qué estudió, chistes internos). Fire-and-forget.
 */
export async function maybeUpdateNotes(groupJid: string): Promise<void> {
  if (!ENABLE_USER_NOTES || countMessages(groupJid) < 20 || Math.random() > 0.3) return;

  const history = getMemory(groupJid);
  const transcript = buildTranscript(history);
  const existing = getAllNotes(groupJid)
    .map((n) => `- ${n.name}: ${n.notes}`)
    .join("\n");

  try {
    // Usa el proveedor LLM configurado para resumir contexto.
    // así la memoria no quema la cuota gratis de Google
    const extractPrompt =
      `Transcripción de un grupo de WhatsApp:\n\n${transcript}\n\n` +
      `Memoria existente:\n${existing || "(vacía)"}\n\n` +
      `Resume solo información práctica y explícitamente compartida que ayude a evitar preguntas repetidas. No infieras atributos ni guardes datos sensibles, identificadores, direcciones, contactos, credenciales, salud o creencias. Devuelve una línea por persona, formato "nombre: contexto útil"; máximo seis personas. Si no hay nada útil nuevo, responde solo "-".`;

    let out = await callOpenRouter(
      'Sos un extractor de datos. Respondés solo líneas formato "nombre: datos" en español. Sin explicaciones.',
      extractPrompt,
    );

    if (!out || out === "-") return;
    for (const line of out.split("\n")) {
      const m = line.match(/^[-•]?\s*(.+?):\s*(.+)$/);
      if (m && m[2].length > 5) saveNotes(groupJid, m[1].trim(), m[2].trim());
    }
    console.log("[bot] memoria de personas actualizada");
  } catch (e) {
    console.log("[bot] updateNotes falló (no pasa nada):", (e as Error).message?.slice(0, 80));
  }
}
