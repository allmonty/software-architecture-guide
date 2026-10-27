import { Diagram } from "../../schema/diagram.schema.ts";

export interface System {
  id: string;
  diagram: Diagram;
  markdown: string;
}

const diagrams = import.meta.glob("../../systems/*.diagram.json", { eager: true, import: "default" });
const notes = import.meta.glob("../../systems/*.md", { eager: true, query: "?raw", import: "default" });

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
    return [{ id: parsed.data.id, diagram: parsed.data, markdown: md ?? "" }];
  })
  .sort((a, b) => a.id.localeCompare(b.id));

// Toolkit pages (primers P, casebook C, workbook W, README) are plain Markdown without a diagram.
export interface ToolkitPage { id: string; title: string; markdown: string }
const toolkit = import.meta.glob("../../toolkit/*.md", { eager: true, query: "?raw", import: "default" });
export const toolkitPages: ToolkitPage[] = Object.entries(toolkit)
  .map(([path, md]) => {
    const id = path.split("/").pop()!.replace(/\.md$/, "");
    const title = (md as string).split("\n")[0].replace(/^#\s*/, "");
    return { id, title, markdown: md as string };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

// ---- Study tracks -------------------------------------------------------------------------------------------
import tracksData from "./tracks.json";

export interface Step { ref: string; why?: string }
export interface Track { id: string; title: string; audience: string; summary: string; steps: Step[] }
export const tracks: Track[] = tracksData.tracks as Track[];

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
  return { ref, type, title: p.title.replace(/^[PCW]\d\d — /, ""), href: `#toolkit/${p.id}`, minutes: minutes(p.markdown) };
}
