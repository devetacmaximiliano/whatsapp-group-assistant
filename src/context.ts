import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONTEXT_DIR = "data/context";

/**
 * Carga todos los .md de data/context/ y los concatena.
 * Así podés agregar/datos nuevos (PDFs convertidos, notas, etc.)
 * sin tocar código: tirás un archivo .md en la carpeta y listo.
 */
export function loadContext(): string {
  let files: string[] = [];
  try {
    files = readdirSync(CONTEXT_DIR).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
  } catch {
    return "";
  }

  const parts = files.map((f) => {
    const content = readFileSync(join(CONTEXT_DIR, f), "utf8");
    return `### Fuente: ${f}\n${content}`;
  });

  return parts.join("\n\n");
}
