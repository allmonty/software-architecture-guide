// Shared by the quote verifier, the freshness report and the site, so they agree on what counts as what.

// Domains whose pages explain or summarise other people's work. A quote found only there shows what that page says,
// not what the primary source says. Everything not listed is treated as primary, which is a judgement by domain,
// not a check of each page (a company blog can still repeat hearsay).
const SECONDARY = [
  "wikipedia.org", "systemdesign.one", "highscalability.com", "substack.com", "2minutestreaming.com", "awsinsider.net",
  "techcrunch.com", "streaminglearningcenter.com", "datacenterdynamics.com", "dev.to", "geeksforgeeks.org", "educative.io",
  "bytebytego.com", "hellointerview.com",
  // Tutorials, glossaries and vendor marketing pages we cite as leads.
  "codecommit.com", "questdb.com", "onixs.biz", "investor.gov", "aiven.io",
];
// GitHub hosts primary sources (a company's own repository) and study guides. List the guides by path.
const SECONDARY_PATHS = ["github.com/donnemartin/", "github.com/mehdihadeli/", "github.com/yuvadm/"];
// Company engineering blogs hosted on Medium are primary; any other Medium page is not.
const MEDIUM_PRIMARY = ["twitch-engineering"];

export type SourceClass = "primary" | "secondary";

export function classifySource(url: string): SourceClass {
  let u: URL;
  try { u = new URL(url); } catch { return "secondary"; }
  const host = u.hostname.replace(/^www\./, "");
  if (SECONDARY_PATHS.some((p) => `${host}${u.pathname}`.toLowerCase().startsWith(p))) return "secondary";
  if (host === "medium.com") return MEDIUM_PRIMARY.includes(u.pathname.split("/")[1]) ? "primary" : "secondary";
  return SECONDARY.some((d) => host === d || host.endsWith("." + d)) ? "secondary" : "primary";
}

const DATE = String.raw`(\d{4}-\d{2}-\d{2})`;
/** The newest date a note says it read or re-checked its sources, as YYYY-MM-DD, or undefined. */
export function lastReadDate(md: string): string | undefined {
  const re = new RegExp(String.raw`(?:read on|Fact-check,|Re-verification[^\n]*?,|verified on)\s*\**${DATE}`, "gi");
  return [...md.matchAll(re)].map((m) => m[1]).sort().at(-1);
}

export const STALE_DAYS = 180;
export const ageInDays = (date: string, now = Date.now()) => Math.floor((now - Date.parse(date)) / 864e5);

export interface LedgerEntry { quote: string; url?: string; via?: string; sourceClass?: SourceClass; status: "confirmed" | "manual" | "ignored" | "unverified"; note?: string }

export interface QuoteTally { primary: number; secondary: number; manual: number; ignored: number; unverified: number }

/** Counts ledger entries. "primary" and "secondary" are both confirmed: the words were found in a cited page of that class. */
export function summarizeLedger(entries: LedgerEntry[]): QuoteTally {
  const t: QuoteTally = { primary: 0, secondary: 0, manual: 0, ignored: 0, unverified: 0 };
  for (const e of entries) {
    if (e.status === "confirmed") t[e.sourceClass ?? (e.url ? classifySource(e.url) : "secondary")]++;
    else t[e.status]++;
  }
  return t;
}

const GAP = /\b(did not|not compared|not quoted|not re-read|not re-verified|not checked)\b/i;

/**
 * What a page says it did not read, check or claim: "Not read" lines anywhere (including blockquotes and numbered notes),
 * and bullets of the "Verification log" that start with "Not" or say a check was not done.
 */
export function notVerified(md: string): string[] {
  const out: string[] = [];
  const add = (t: string) => { const x = t.trim(); if (x && !out.includes(x)) out.push(x); };
  for (const line of md.split("\n")) {
    const m = line.match(/^(?:>\s*)?(?:\d+\.\s+)?(\*\*Not (?:read|checked|re-verified|re-read)[^\n]*)/i);
    if (m) add(m[1]);
  }
  const start = md.search(/^## .*verification log/im);
  if (start >= 0) {
    const bullets: string[] = [];
    for (const line of md.slice(start).split("\n").slice(1)) {
      if (/^#{1,2} /.test(line)) break;
      if (/^- /.test(line)) bullets.push(line.slice(2));
      else if (/^\s+\S/.test(line) && bullets.length) bullets[bullets.length - 1] += " " + line.trim();
    }
    for (const b of bullets) if (/^\**not\b/i.test(b) || GAP.test(b)) add(b);
  }
  return out;
}
