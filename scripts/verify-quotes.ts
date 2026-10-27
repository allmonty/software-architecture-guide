// Checks every quotation in the notes against the sources the note cites, and keeps a per-note ledger
// (systems/NN-*.claims.json) of which URL confirmed which quote.
//
//   npm run verify                 re-check the ledger and report quotes that are not in it
//   npm run verify -- --write      fetch all cited sources, update the ledgers
//   npm run verify -- 07 13        only these systems
// PDFs need Python with pypdf: PYTHON=/path/to/python npm run verify
//
// Pages are fetched with a browser user agent, falling back to the Internet Archive when blocked.
// Pages that render client-side or decode badly cannot be checked: those quotes are listed as unverified.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const dirs = [join(root, "systems"), join(root, "toolkit")].filter((d) => existsSync(d));
const cache = join(root, ".cache", "sources");
mkdirSync(cache, { recursive: true });

// Sections that contain our own reasoning or prompts rather than quotations of sources.
const SKIP_SECTIONS = /interview questions|architecture lens|verification log|non-technical|reviewer notes|further reading/i;

export const norm = (t: string) =>
  t.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/ﬀ/g, "ff").replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl")
    .replace(/-\s+/g, "").replace(/[^a-z0-9% ]+/g, " ").replace(/\s+/g, " ").trim();

const stripHtml = (h: string) =>
  h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/g, "")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function fetchText(url: string): Promise<{ text: string; via: "direct" | "archive" } | null> {
  const key = createHash("sha1").update(url).digest("hex");
  const file = join(cache, key + ".json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  // Apple's documentation pages render client-side; the same text is served as JSON.
  const apple = url.match(/^https:\/\/developer\.apple\.com\/documentation\/([^#?]+)/);
  const attempt = async (u: string) => {
    try {
      if (apple && u === url) {
        const r = await fetch(`https://developer.apple.com/tutorials/data/documentation/${apple[1]}.json`, { signal: AbortSignal.timeout(30000), headers: { "user-agent": "Mozilla/5.0" } });
        if (r.ok) {
          const parts: string[] = [];
          const walk = (x: unknown): void => {
            if (Array.isArray(x)) x.forEach(walk);
            else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) (k === "text" || k === "code") && typeof v === "string" ? parts.push(v) : walk(v);
          };
          walk(await r.json());
          return parts.join(" ");
        }
      }
      const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(30000), headers: { "user-agent": "Mozilla/5.0" } });
      if (!r.ok) return null;
      const type = r.headers.get("content-type") ?? "";
      if (type.includes("pdf") || u.toLowerCase().endsWith(".pdf")) {
        const tmp = join(cache, key + ".pdf");
        writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
        try { return execFileSync(process.env.PYTHON ?? "python3", [join(root, "scripts/pdf2txt.py"), tmp], { maxBuffer: 1 << 26 }).toString(); } catch { return null; }
      }
      return stripHtml(await r.text());
    } catch { return null; }
  };
  let text = await attempt(url), via: "direct" | "archive" = "direct";
  if (!text || text.length < 1500) {
    const a = await attempt(`https://web.archive.org/web/2023/${url}`);
    if (a && a.length > (text?.length ?? 0)) { text = a; via = "archive"; }
  }
  if (!text) return null;
  const out = { text: norm(text), via };
  writeFileSync(file, JSON.stringify(out));
  return out;
}

/** True when every fragment of the quote (split at ellipses and [bracketed edits]) occurs in the source. */
export function quoteIn(quote: string, doc: string): boolean {
  const parts = quote.split(/\.\.\.|…|\[[^\]]*\]/).map(norm).filter((p) => p.length >= 12);
  return parts.length > 0 && parts.every((p) => doc.includes(p));
}

export function quotesOf(md: string): string[] {
  const out = new Set<string>();
  let skip = false, code = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) { code = !code; continue; }
    if (code) continue;
    if (/^#{1,6} /.test(line)) skip = SKIP_SECTIONS.test(line);
    if (skip) continue;
    for (const m of line.matchAll(/["“]([^"”\n]{15,320})["”]/g)) {
      const q = m[1].trim();
      // Quote marks that pair across markdown (bold, links, code) produce fragments, not quotations.
      if (/\*\*|\]\(|`|^[),.;:]|\($/.test(q) || /\)\s*$/.test(q) && !/\(/.test(q)) continue;
      out.add(q);
    }
  }
  return [...out];
}

const urlsOf = (md: string) =>
  [...new Set([...md.matchAll(/https?:\/\/[^\s)>\]"`|]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")))]
    .filter((u) => !/[<>{}]|\.\.\./.test(u) && !u.includes("localhost"));

interface Ledger { quote: string; url?: string; via?: string; status: "confirmed" | "manual" | "ignored" | "unverified"; note?: string }

async function main() {
  const write = process.argv.includes("--write");
  const only = process.argv.slice(2).filter((a) => /^[PCW]?\d\d$/.test(a));
  let missing = 0, unverified = 0, total = 0;
  for (const dir of dirs) for (const f of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    if (f.startsWith("W")) continue; // workbook pages are our own exercises; their quotation marks are not source quotes
    const num = f.match(/^[PCW]?\d\d/)![0];
    if (only.length && !only.includes(num)) continue;
    const md = readFileSync(join(dir, f), "utf8");
    const ledgerPath = join(dir, f.replace(/\.md$/, ".claims.json"));
    const old: Ledger[] = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
    const quotes = quotesOf(md);
    const docs = new Map<string, { text: string; via: string } | null>();
    const get = async (u: string) => { if (!docs.has(u)) docs.set(u, await fetchText(u)); return docs.get(u)!; };
    const ledger: Ledger[] = [];
    for (const q of quotes) {
      total++;
      const manual = old.find((l) => l.quote === q && (l.status === "manual" || l.status === "ignored"));
      if (manual) { ledger.push(manual); continue; } // verified by hand where the page cannot be fetched
      const prior = old.find((l) => l.quote === q && l.status === "confirmed");
      // Re-check the recorded source first, then (when writing) every cited source.
      const candidates = prior?.url ? [prior.url, ...(write ? urlsOf(md) : [])] : write ? urlsOf(md) : [];
      let hit: Ledger | undefined;
      for (const u of candidates) {
        const d = await get(u);
        if (d && quoteIn(q, d.text)) { hit = { quote: q, url: u, via: d.via, status: "confirmed" }; break; }
      }
      if (hit) ledger.push(hit);
      else if (!write && !prior && !old.some((l) => l.quote === q)) { missing++; console.log(`${num}  NOT IN LEDGER  "${q.slice(0, 110)}"`); }
      else if (prior && !write) { missing++; console.log(`${num}  NO LONGER FOUND  "${q.slice(0, 110)}"  (${prior.url})`); }
      else { unverified++; ledger.push({ quote: q, status: "unverified" }); }
    }
    if (write) writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  }
  console.log(`\n${total} quotes checked. ${write ? `${unverified} unverified (kept in the ledgers).` : `${missing} problems.`}`);
  if (!write && missing) process.exit(1);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
