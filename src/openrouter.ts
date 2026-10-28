import "dotenv/config";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Sanitiza la salida: si el modelo expone razonamiento/meta-análisis en vez
 * del mensaje de WhatsApp, se descarta (y el caller cae al fallback).
 */
export function sanitizeReply(text: string): string {
  if (!text) return "";
  // Un mensaje de WhatsApp del asistente debe ser breve y sin listas/markdown
  if (text.length > 280) return "";
  if (/[\n]{2,}|^[-*#]|```/m.test(text)) return "";
  // Meta-texto típico de reasoning filtrado al content
  if (/\b(the user|as an assistant|i should|looking at|the chat|transcript|respond(ing)? as|in this (chat|scenario)|roleplay|persona)\b/i.test(text)) return "";
  // Output corrupto: caracteres CJK/japoneses/coreanos no pertenecen acá (glitches del modelo)
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) return "";
  // Basura de símbolos/controles que un mensaje de WhatsApp no lleva
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|[\u2440-\u24ff]/.test(text)) return "";
  // Cirílico y otros alfabetos ajenos (glitches del modelo tipo "кільcom")
  if (/[\u0400-\u04ff\u0530-\u058f\u0590-\u05ff]/.test(text)) return "";
  // Placeholders y relleno que un mensaje real no lleva ("de una ___")
  if (/_{2,}|\[insert|\(insert/.test(text)) return "";
  // Frase arrancando con meta-inglés
  if (/^(okay|ok,|sure,|alright|i'll|i will|here('s| is))\b/i.test(text)) return "";
  // Fugas de tool-calls / JSON / prompt (arquitectura Captain: LeakedToolCallError)
  // El prefijo [audio] es legítimo (dispara la nota de voz) — no confundirlo con fuga JSON
  if (/^\s*[{[]/.test(text) && !/^\s*\[audio\]/i.test(text)) return "";
  if (/\b(to=functions\.|tool_call|system prompt|instrucciones del sistema|mi prompt)\b/i.test(text)) return "";
  // El bot nunca "cita" reglas internas ni habla de su persona como instrucción
  if (/\b(mi personalidad|mi rol|me programaron|fui programado)\b/i.test(text)) return "";
  return text.trim();
}

/**
 * Fallback vía OpenRouter (API compatible OpenAI).
 * Devuelve el texto de la respuesta o "" si falla.
 */
export async function callOpenRouter(
  system: string,
  user: string,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return "";

  // Lista de candidatos free en orden de preferencia: si uno falla o tiene
  // el provider roto (pasa seguido con modelos free), prueba el siguiente
  const models = (process.env.OPENROUTER_MODELS ?? process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const model of models) {
    const reply = await callModel(apiKey, model, system, user);
    if (reply) return reply;
  }
  return "";
}

/**
 * Igual que callOpenRouter pero SIN sanitizar: solo para la decisión de
 * participación (generateParticipation), cuya salida válida ES un JSON —
 * sanitizeReply lo descartaría por su regla anti-fuga. El sanitizado del
 * texto visible lo hace generateParticipation sobre decision.texto.
 */
export async function callOpenRouterRaw(
  system: string,
  user: string,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return "";

  // Misma lista de candidatos free que callOpenRouter (orden de preferencia)
  const models = (process.env.OPENROUTER_MODELS ?? process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const model of models) {
    const reply = await callModel(apiKey, model, system, user, false);
    if (reply) return reply;
  }
  return "";
}

async function callModel(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  sanitize: boolean = true,
): Promise<string> {
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Headers recomendados por OpenRouter (opcional, para rankings)
        "HTTP-Referer": "http://localhost",
        "X-Title": "whatsapp-group-assistant",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 1.15,
        max_tokens: 300,
        // Control de reasoning: los modelos de razonamiento (Nemotron, GLM)
        // exponen la cadena de pensamiento si no se controla
        ...(process.env.OPENROUTER_REASONING
          ? { reasoning: { effort: process.env.OPENROUTER_REASONING } }
          : { reasoning: { enabled: false, exclude: true } }),
      }),
    });

    if (!res.ok) {
      console.log(`[bot] OpenRouter ${model} falló (${res.status})`);
      return "";
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    const out = sanitize ? sanitizeReply(raw) : raw;
    if (out) console.log(`[bot] respuesta vía ${model}`);
    return out;
  } catch (err) {
    console.log(`[bot] OpenRouter ${model} error:`, err);
    return "";
  }
}
