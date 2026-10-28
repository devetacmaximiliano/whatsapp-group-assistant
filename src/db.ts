import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });

const db = new DatabaseSync("data/bot.db");

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_jid, ts);
  CREATE TABLE IF NOT EXISTS user_notes (
    group_jid TEXT NOT NULL,
    name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_jid, name)
  );
`);

export function insertMessage(groupJid: string, name: string, text: string, ts: number): void {
  db.prepare("INSERT INTO messages (group_jid, name, text, ts) VALUES (?, ?, ?, ?)")
    .run(groupJid, name, text, ts);
}

export function getRecentMessages(groupJid: string, limit: number): { name: string; text: string; ts: number }[] {
  return db
    .prepare("SELECT name, text, ts FROM messages WHERE group_jid = ? ORDER BY ts DESC LIMIT ?")
    .all(groupJid, limit)
    .map((r: any) => ({ name: r.name, text: r.text, ts: r.ts }))
    .reverse();
}

export function countMessages(groupJid: string): number {
  const r: any = db
    .prepare("SELECT COUNT(*) as n FROM messages WHERE group_jid = ? AND ts > ?")
    .get(groupJid, Date.now() - 60 * 60 * 1000);
  return r?.n ?? 0;
}

export function getNotes(groupJid: string, name: string): string {
  const r: any = db
    .prepare("SELECT notes FROM user_notes WHERE group_jid = ? AND name = ?")
    .get(groupJid, name);
  return r?.notes ?? "";
}

export function getAllNotes(groupJid: string): { name: string; notes: string }[] {
  return db
    .prepare("SELECT name, notes FROM user_notes WHERE group_jid = ? AND notes != ''")
    .all(groupJid)
    .map((r: any) => ({ name: r.name, notes: r.notes }));
}

export function saveNotes(groupJid: string, name: string, notes: string): void {
  db.prepare(`
    INSERT INTO user_notes (group_jid, name, notes, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(group_jid, name) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at
  `).run(groupJid, name, notes, Date.now());
}
