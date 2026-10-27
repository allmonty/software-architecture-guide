import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Diagram } from "../schema/diagram.schema.ts";

// Every system .md must contain these headings (substring match on `##` lines).
export const REQUIRED_SECTIONS = [
  "At a glance",
  "Non-technical explanation",
  "TL;DR",
  "Architecture lens",
  "Interview questions",
  "Interview practice",
  "Further reading",
  "Sources and provenance",
  "Verification log",
];

const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

/** Returns a list of human-readable problems; empty means the directory is valid. */
export function validateDir(dir: string): string[] {
  const errors: string[] = [];
  const files = readdirSync(dir);
  const stems = new Set(
    files.filter((f) => f.endsWith(".md") || f.endsWith(".diagram.json")).map((f) => f.replace(/(\.diagram\.json|\.md)$/, "")),
  );

  for (const stem of [...stems].sort()) {
    const err = (m: string) => errors.push(`${stem}: ${m}`);
    const mdPath = join(dir, `${stem}.md`);
    const jsonPath = join(dir, `${stem}.diagram.json`);
    if (!existsSync(mdPath)) err("missing .md");
    if (!existsSync(jsonPath)) err("missing .diagram.json");
    if (!existsSync(mdPath) || !existsSync(jsonPath)) continue;

    const md = readFileSync(mdPath, "utf8");
    const headings = md.split("\n").filter((l) => l.startsWith("#"));
    for (const s of REQUIRED_SECTIONS) {
      if (!headings.some((h) => h.includes(s))) err(`md missing section "${s}"`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch (e) {
      err(`invalid JSON: ${(e as Error).message}`);
      continue;
    }
    const parsed = Diagram.safeParse(raw);
    if (!parsed.success) {
      for (const i of parsed.error.issues) err(`schema: ${i.path.join(".")}: ${i.message}`);
      continue;
    }
    const d = parsed.data;

    if (d.id !== stem) err(`diagram id "${d.id}" must equal file stem`);
    if (!headings[0]?.includes(d.title)) err(`md H1 must contain diagram title "${d.title}"`);

    // Relative links must point at files that exist (anchors and URLs are skipped).
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      if (!existsSync(resolve(dirname(mdPath), target))) err(`broken relative link: ${m[1]}`);
    }

    const nodeIds = d.nodes.map((n) => n.id);
    for (const x of dupes(nodeIds)) err(`duplicate node id ${x}`);
    const edgeIds = d.edges.map((e) => e.id);
    for (const x of dupes(edgeIds)) err(`duplicate edge id ${x}`);
    const nodes = new Set(nodeIds);
    const edges = new Map(d.edges.map((e) => [e.id, e]));

    for (const e of d.edges) {
      if (!nodes.has(e.from)) err(`edge ${e.id}: unknown node ${e.from}`);
      if (!nodes.has(e.to)) err(`edge ${e.id}: unknown node ${e.to}`);
    }
    for (const f of d.flows) {
      f.steps.forEach((s, i) => {
        if (!edges.has(s.edge)) err(`flow ${f.id} step ${i + 1}: unknown edge ${s.edge}`);
      });
    }
    const byId = new Map(d.nodes.map((n) => [n.id, n]));
    if (!d.nodes.some((n) => n.c4 === "container")) err("C4: needs at least one container");
    for (const n of d.nodes) {
      if (n.c4 === "component") {
        if (!n.parent || byId.get(n.parent)?.c4 !== "container") err(`C4: component ${n.id} needs a container parent`);
      } else if (n.parent) err(`C4: only components have a parent (${n.id})`);
    }
    for (const n of d.nodes) {
      if (n.confidence !== "SPECULATIVE" && n.sources.length === 0) {
        err(`node ${n.id}: ${n.confidence} needs at least one source`);
      }
    }
  }
  return errors;
}

// Toolkit pages (primers P, casebook C, workbook W) have no diagram: they need the provenance headings,
// a unique H1, and relative links that resolve.
export const TOOLKIT_SECTIONS = ["Sources and provenance", "Verification log"];

export function validateToolkit(dir: string): string[] {
  const errors: string[] = [];
  if (!existsSync(dir)) return errors;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const err = (m: string) => errors.push(`toolkit/${f}: ${m}`);
    if (f === "README.md") continue;
    if (!/^[PCW]\d\d-[a-z0-9-]+\.md$/.test(f)) err("file name must look like P01-slug.md, C01-slug.md or W01-slug.md");
    const mdPath = join(dir, f);
    const md = readFileSync(mdPath, "utf8");
    const headings = md.split("\n").filter((l) => l.startsWith("#"));
    if (!headings[0]?.startsWith("# ")) err("must start with an H1");
    for (const s of TOOLKIT_SECTIONS) if (!headings.some((h) => h.startsWith("##") && h.includes(s))) err(`missing section "${s}"`);
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      if (!existsSync(resolve(dirname(mdPath), target))) err(`broken relative link: ${m[1]}`);
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = resolve(fileURLToPath(import.meta.url), "../..");
  const dir = join(here, "systems");
  const errors = [...validateDir(dir), ...validateToolkit(join(here, "toolkit"))];
  if (errors.length) {
    console.error(errors.map((e) => `✗ ${e}`).join("\n"));
    process.exit(1);
  }
  console.log("✓ all systems valid");
}
