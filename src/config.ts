import "dotenv/config";

export const BOT_NAME = process.env.BOT_NAME?.trim() || "Asistente";
export const SPONTANEOUS_LEVEL = Math.min(2, Math.max(0, Number(process.env.SPONTANEOUS_LEVEL ?? 0)));
export const ENABLE_USER_NOTES = process.env.ENABLE_USER_NOTES?.toLowerCase() === "true";
