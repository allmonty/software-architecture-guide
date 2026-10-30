// Writes llms.txt, llms-full.txt and raw Markdown copies of the English notes into site/public/ so crawlers and
// coding agents can read the notes without running the SPA. Generated files are gitignored; `npm run build` runs this first.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Note { dir: string; file: string; title: string }

const SUMMARY =
  "A system-design study set: 35 systems and a toolkit (casebook, primers, workbook). Each note is sourced from primary material, tags claims as CONFIRMED, INDUSTRY PATTERN or SPECULATIVE, and ends with a verification log that says what was not checked. Licensed CC BY 4.0.";

export function listNotes(root: string): Note[] {
  return ["systems", "toolkit"].flatMap((dir) =>
    readdirSync(join(root, dir)).filter((f) => f.endsWith(".md") && f !== "README.md").sort().map((file) => {
      const h1 = readFileSync(join(root, dir, file), "utf8").split("\n").find((l) => l.startsWith("# "));
      return { dir, file, title: h1 ? h1.slice(2).trim() : file };
    }));
}

export function llmsTxt(notes: Note[]): string {
  const section = (name: string, dir: string) =>
    `## ${name}\n\n` + notes.filter((n) => n.dir === dir).map((n) => `- [${n.title}](md/${n.dir}/${n.file})`).join("\n");
  return `# System Design Atlas\n\n> ${SUMMARY}\n\nStart with md/README.md for the index and learning path. Full text of everything: llms-full.txt.\n\n${section("Systems", "systems")}\n\n${section("Toolkit", "toolkit")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const out = join(root, "site/public");
  const notes = listNotes(root);
  mkdirSync(join(out, "md/systems"), { recursive: true });
  mkdirSync(join(out, "md/toolkit"), { recursive: true });
  copyFileSync(join(root, "README.md"), join(out, "md/README.md"));
  for (const n of notes) copyFileSync(join(root, n.dir, n.file), join(out, "md", n.dir, n.file));
  writeFileSync(join(out, "llms.txt"), llmsTxt(notes));
  const full = [join(root, "README.md"), ...notes.map((n) => join(root, n.dir, n.file))].map((f) => readFileSync(f, "utf8"));
  writeFileSync(join(out, "llms-full.txt"), full.join("\n\n---\n\n"));
  console.log(`llms: ${notes.length} notes`);
}
