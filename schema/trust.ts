// Shared by the quote verifier, the freshness report and the site, so they agree on what counts as what.

// Domains whose pages explain or summarise other people's work. A quote found only there shows what that page says,
// not what the primary source says. Everything not listed is treated as primary, which is a judgement by domain,
// not a check of each page (a company blog can still repeat hearsay).
const SECONDARY = [
  "wikipedia.org", "systemdesign.one", "highscalability.com", "substack.com", "2minutestreaming.com", "awsinsider.net",
  "techcrunch.com", "streaminglearningcenter.com", "datacenterdynamics.com", "dev.to", "geeksforgeeks.org", "educative.io",
  "bytebytego.com", "hellointerview.com",
];
// Company engineering blogs hosted on Medium are primary; any other Medium page is not.
const MEDIUM_PRIMARY = ["twitch-engineering"];

export type SourceClass = "primary" | "secondary";

export function classifySource(url: string): SourceClass {
  let u: URL;
  try { u = new URL(url); } catch { return "secondary"; }
  const host = u.hostname.replace(/^www\./, "");
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
