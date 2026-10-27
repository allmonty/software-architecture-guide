// Lists notes by the date of their last source read, oldest first, and flags those older than the threshold.
//   npm run freshness [-- --days 180]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = resolve(fileURLToPath(import.meta.url), "../..");
const dirs = ["systems", "toolkit"].map((d) => join(base, d)).filter((d) => existsSync(d));
const arg = process.argv.indexOf("--days");
const limit = arg > 0 ? Number(process.argv[arg + 1]) : 180;
const rows = dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("W")).sort().map((f) => ({ dir, f }))).map(({ dir, f }) => {
  const md = readFileSync(join(dir, f), "utf8");
  const dates = [...md.matchAll(/(?:read on|Fact-check,|Re-verification[^\n]*?,|verified on)\s*\**(\d{4}-\d{2}-\d{2})/gi)].map((m) => m[1]).sort();
  return { f, last: dates.at(-1) ?? "unknown" };
});
const today = Date.now();
let stale = 0;
for (const r of rows.sort((a, b) => a.last.localeCompare(b.last))) {
  const age = r.last === "unknown" ? Infinity : Math.floor((today - Date.parse(r.last)) / 864e5);
  const flag = age > limit ? "STALE" : "ok";
  if (age > limit) stale++;
  console.log(`${flag.padEnd(5)} ${r.last}  ${Number.isFinite(age) ? age + "d" : "?"}  ${r.f}`);
}
console.log(`\n${stale} of ${rows.length} notes older than ${limit} days.`);
