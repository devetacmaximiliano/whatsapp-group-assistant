import { insertMessage, getRecentMessages } from "./db.js";

export type Msg = { name: string; text: string; ts: number };

export function pushMemory(groupJid: string, msg: Msg): void {
  insertMessage(groupJid, msg.name, msg.text, msg.ts);
}

export function getMemory(groupJid: string): Msg[] {
  return getRecentMessages(groupJid, 60);
}
