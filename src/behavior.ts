import { SPONTANEOUS_LEVEL } from "./config.js";

/** Delay before responding, based on message length and whether it looks direct. */
export function readingDelay(text: string): number {
  const isDirect = /@|\?|¿/.test(text);
  const short = text.length < 80;
  if (isDirect && short) return 2_000 + Math.random() * 5_000;
  if (isDirect) return 5_000 + Math.random() * 8_000;
  if (short) return 8_000 + Math.random() * 15_000;
  return 15_000 + Math.random() * 30_000;
}

export function typingDuration(reply: string): number {
  return Math.min(800 + reply.length * 55, 10_000);
}

export function isDirectMention(text: string, quoted?: { name: string; text: string }): boolean {
  return Boolean(quoted) || /@|\?|¿/.test(text);
}

/** Spontaneous messages are opt-in; level 0 disables them. */
export function spontaneousQuestionChance(): number {
  if (SPONTANEOUS_LEVEL === 0) return 0;
  return SPONTANEOUS_LEVEL === 1 ? 0.04 : 0.08;
}

const lastReply = new Map<string, number>();
export function canReplyNow(groupJid: string, minGapMs = 25_000): boolean {
  return Date.now() - (lastReply.get(groupJid) ?? 0) >= minGapMs;
}
export function markReplied(groupJid: string): void {
  lastReply.set(groupJid, Date.now());
}

/** Quiet hours in local time, configured as e.g. "3-9". */
export function isSleepHours(): boolean {
  const range = (process.env.BOT_OFFLINE_HOURS ?? "")
    .split("-")
    .map((n) => Number(n.trim()));
  if (range.length !== 2 || range.some((n) => Number.isNaN(n))) return false;
  const h = new Date().getHours();
  const [from, to] = range;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

export const SPONTANEOUS_QUESTIONS = [
  "¿alguien necesita ayuda con algo?",
  "¿qué tema les gustaría conversar?",
  "¿hay alguna pregunta pendiente en la que pueda ayudar?",
];
