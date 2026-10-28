import { parseConcepts } from "../../schema/concepts.ts";
import { Diagram } from "../../schema/diagram.schema.ts";
import type { Lang } from "./settings-core.ts";
import { ageInDays, lastReadDate, notVerified, STALE_DAYS, summarizeLedger, type LedgerEntry, type QuoteTally } from "../../schema/trust.ts";

export interface System {
  id: string;
  diagram: Diagram;
  markdown: string;
  claims: LedgerEntry[];
}

const diagrams = import.meta.glob("../../systems/*.diagram.json", { eager: true, import: "default" });
const notes = import.meta.glob("../../systems/*.md", { eager: true, query: "?raw", import: "default" });
const ledgers = import.meta.glob("../../systems/*.claims.json", { eager: true, import: "default" });

// Parsing at load time means a malformed file fails loudly in the browser console and is skipped,
// while `npm run validate` is the gate that keeps it from being committed.
export const systems: System[] = Object.entries(diagrams)
  .flatMap(([path, raw]) => {
    const parsed = Diagram.safeParse(raw);
    if (!parsed.success) {
      console.error(`Invalid diagram ${path}`, parsed.error.issues);
      return [];
    }
    const md = notes[path.replace(".diagram.json", ".md")] as string | undefined;
    const claims = (ledgers[path.replace(".diagram.json", ".claims.json")] as LedgerEntry[] | undefined) ?? [];
    return [{ id: parsed.data.id, diagram: parsed.data, markdown: md ?? "", claims }];
  })
  .sort((a, b) => a.id.localeCompare(b.id));

// Toolkit pages (primers P, casebook C, workbook W, README) are plain Markdown without a diagram.
export interface ToolkitPage { id: string; title: string; markdown: string; claims: LedgerEntry[] }
const toolkit = import.meta.glob("../../toolkit/*.md", { eager: true, query: "?raw", import: "default" });
const toolkitLedgers = import.meta.glob("../../toolkit/*.claims.json", { eager: true, import: "default" });
export const toolkitPages: ToolkitPage[] = Object.entries(toolkit)
  .map(([path, md]) => {
    const id = path.split("/").pop()!.replace(/\.md$/, "");
    const title = (md as string).split("\n")[0].replace(/^#\s*/, "");
    return { id, title, markdown: md as string, claims: (toolkitLedgers[path.replace(/\.md$/, ".claims.json")] as LedgerEntry[] | undefined) ?? [] };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

// ---- Study tracks -------------------------------------------------------------------------------------------
import tracksData from "./tracks.json";

export interface Step { ref: string; why?: string }
export interface Track { id: string; title: string; audience: string; summary: string; steps: Step[] }
export const tracks: Track[] = tracksData.tracks as Track[];

// pt-BR text laid over the English: only the prose fields, keyed by track id / step ref / English stage title.
// Anything missing falls back to the English, so a half-translated overlay still works.
import trackPt from "./locales/pt-BR/tracks.json";
import stagePt from "./locales/pt-BR/stages.json";
type TrackText = { title?: string; audience?: string; summary?: string; why?: Record<string, string> };
export const trackText = trackPt as Record<string, TrackText>;
export const stageText = stagePt as Record<string, { title: string; blurb: string }>;

export function trackIn(t: Track, lang: Lang): Track {
  const o = lang === "pt-BR" ? trackText[t.id] : undefined;
  return o ? { ...t, title: o.title ?? t.title, audience: o.audience ?? t.audience, summary: o.summary ?? t.summary, steps: t.steps.map((s) => ({ ...s, why: o.why?.[s.ref] ?? s.why })) } : t;
}
export const stageIn = <S extends { title: string; blurb: string }>(s: S, lang: Lang): S =>
  lang === "pt-BR" ? { ...s, ...stageText[s.title] } : s;

export type ItemType = "System" | "Primer" | "Incident" | "Exercise";
export interface Item {
  ref: string; type: ItemType; title: string; href: string; minutes: number; kind?: "real-system" | "reference-design";
}
// Technical prose with tables is read slowly: 150 words a minute, rounded to 5. This counts reading only, not drills.
const minutes = (md: string) => Math.max(5, Math.round(md.split(/\s+/).length / 150 / 5) * 5);

/** Resolves "22" (a system) or "P03" / "C02" / "W01" (a toolkit page) to what the UI needs, or undefined. */
export function resolveRef(ref: string): Item | undefined {
  if (/^\d\d$/.test(ref)) {
    const s = systems.find((x) => x.id.startsWith(ref + "-"));
    return s && { ref, type: "System", title: s.diagram.title, href: `#${s.id}`, minutes: minutes(s.markdown), kind: s.diagram.kind };
  }
  const p = toolkitPages.find((x) => x.id.startsWith(ref + "-"));
  if (!p) return undefined;
  const type: ItemType = ref[0] === "P" ? "Primer" : ref[0] === "C" ? "Incident" : "Exercise";
  // Workbook pages are practice, not reading: their length says nothing about how long a session takes.
  return { ref, type, title: p.title.replace(/^[PCW]\d\d — /, ""), href: `#toolkit/${p.id}`, minutes: type === "Exercise" ? 0 : minutes(p.markdown) };
}

// ---- Trust summary ------------------------------------------------------------------------------------------
export interface Trust {
  lastRead?: string; ageDays?: number; stale: boolean;
  quotes: QuoteTally; quoteTotal: number;
  nodes?: { confirmed: number; pattern: number; speculative: number };
  notVerified: string[];
}
/** What the reader needs to judge a page: how fresh, how its quotes were checked, what it says it did not verify. */
export function trustOf(markdown: string, claims: LedgerEntry[], diagram?: Diagram): Trust {
  const lastRead = lastReadDate(markdown);
  const ageDays = lastRead ? ageInDays(lastRead) : undefined;
  const quotes = summarizeLedger(claims);
  return {
    lastRead, ageDays, stale: ageDays === undefined || ageDays > STALE_DAYS,
    quotes, quoteTotal: claims.length,
    nodes: diagram && {
      confirmed: diagram.nodes.filter((n) => n.confidence === "CONFIRMED").length,
      pattern: diagram.nodes.filter((n) => n.confidence === "INDUSTRY PATTERN").length,
      speculative: diagram.nodes.filter((n) => n.confidence === "SPECULATIVE").length,
    },
    notVerified: notVerified(markdown),
  };
}

// ---- Concepts (the README matrix) ----------------------------------------------------------------------------
import readme from "../../README.md?raw";
export const concepts = parseConcepts(readme);
