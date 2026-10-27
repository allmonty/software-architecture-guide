// Checks every external link in the notes and README. Sites that block scripts (403, 406, 999) are reported as
// "blocked", not broken, because the page may be fine in a browser. Exit code is 1 only for real failures.
//   npm run links
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const files = [join(root, "README.md"), ...readdirSync(join(root, "systems")).filter((f) => f.endsWith(".md")).map((f) => join(root, "systems", f))];
const urls = new Map<string, Set<string>>();
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/https?:\/\/[^\s)>\]"`|]+/g)) {
    const u = m[0].replace(/[.,;:]+$/, "");
    if (/[<>{}]|\.\.\.|localhost/.test(u)) continue;
    (urls.get(u) ?? urls.set(u, new Set()).get(u)!).add(f.slice(root.length + 1));
  }
}
// Known to answer scripts with an error although the page exists (verified by hand).
const KNOWN = new Set([
  "https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying",
  "https://bit.ly/github", // an observed redirect, not a link to follow
]);

async function check(u: string): Promise<number> {
  try {
    const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(25000), headers: { "user-agent": "Mozilla/5.0" } });
    return r.status;
  } catch { return 0; }
}

const results: [string, number][] = [];
const queue = [...urls.keys()];
await Promise.all(Array.from({ length: 10 }, async () => {
  for (let u = queue.pop(); u; u = queue.pop()) results.push([u, await check(u)]);
}));
const bad = results.filter(([, s]) => s >= 300 && s !== 301).sort();
const blocked = bad.filter(([, s]) => [401, 403, 406, 429, 999].includes(s));
const broken = bad.filter(([u, s]) => ![401, 403, 406, 429, 999].includes(s) && !KNOWN.has(u));
console.log(`${urls.size} links. ${blocked.length} blocked scripts (check by hand), ${broken.length} broken.`);
for (const [u, s] of broken) console.log(`  ${s || "ERR"}  ${u}  (${[...urls.get(u)!].join(", ")})`);
if (broken.length) process.exit(1);
