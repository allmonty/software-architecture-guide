import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Recent commits per note (date and subject), read from git when the site is built or served. Without git or
// outside a checkout it is empty and the pages simply show no change history.
function noteHistory(): Record<string, { date: string; subject: string }[]> {
  const root = resolve(__dirname, "..");
  const out: Record<string, { date: string; subject: string }[]> = {};
  try {
    for (const dir of ["systems", "toolkit"]) {
      for (const f of readdirSync(join(root, dir)).filter((f) => f.endsWith(".md"))) {
        const log = execFileSync("git", ["log", "-n", "8", "--format=%cs%x09%s", "--", join(dir, f)], { cwd: root, encoding: "utf8" });
        out[f.replace(/\.md$/, "")] = log.split("\n").filter(Boolean).map((l) => { const [date, ...s] = l.split("\t"); return { date, subject: s.join("\t") }; });
      }
    }
  } catch { /* no git: no history */ }
  return out;
}

// Relative base so the static build works from any path (GitHub Pages, file server).
export default defineConfig({
  base: "./",
  plugins: [react()],
  // GitHub Pages serves the docs/ folder of the main branch, so the build goes there (committed).
  build: { outDir: "../docs", emptyOutDir: true },
  define: { __NOTE_HISTORY__: JSON.stringify(noteHistory()) },
  server: { fs: { allow: [".."] } },
});
