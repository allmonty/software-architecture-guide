import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Diagram } from "../schema/diagram.schema.ts";
import { lastReadDate, notVerified } from "../schema/trust.ts";

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
    // Every study note must show at least one case where things go wrong, and say so in the flow itself.
    if (!d.flows.some((f) => f.failure)) err("needs at least one flow marked failure: true");
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

// Every step of every study track on the home page must point at a real system or toolkit page.
export function validateTracks(file: string, systemsDir: string, toolkitDir: string): string[] {
  const errors: string[] = [];
  if (!existsSync(file)) return errors;
  const data = JSON.parse(readFileSync(file, "utf8")) as { tracks: { id: string; title: string; steps: { ref: string }[] }[] };
  const names = [...(existsSync(systemsDir) ? readdirSync(systemsDir) : []), ...(existsSync(toolkitDir) ? readdirSync(toolkitDir) : [])];
  const ids = data.tracks.map((t) => t.id);
  for (const x of dupes(ids)) errors.push(`tracks: duplicate track id ${x}`);
  for (const t of data.tracks) {
    if (!t.title || t.steps.length === 0) errors.push(`tracks: ${t.id} needs a title and steps`);
    for (const x of dupes(t.steps.map((s) => s.ref))) errors.push(`tracks: ${t.id} lists ${x} twice`);
    for (const s of t.steps) {
      if (!names.some((n) => n.startsWith(s.ref + "-") && n.endsWith(".md"))) errors.push(`tracks: ${t.id} step ${s.ref} matches no system or toolkit page`);
    }
  }
  return errors;
}

// Translated notes (locales/<lang>/{systems,toolkit}/X.md) may change the prose only. The site, the trust card and the
// validator match English headings, phrases and tags, and the glossary lists terms that stay English, so a translation
// must keep: the original's ## headings, its link targets and confidence tags, its source date and "Not ..." list, and
// every glossary term the original uses.
export function validateTranslations(localesDir: string, rootDir: string, glossary: string[]): string[] {
  const errors: string[] = [];
  if (!existsSync(localesDir)) return errors;
  const bag = (md: string, re: RegExp) => [...md.matchAll(re)].map((m) => m[1] ?? m[0]).sort().join("\n");
  const h2 = (md: string) => md.split("\n").filter((l) => l.startsWith("## ")).join("\n");
  for (const folder of ["systems", "toolkit"]) {
    const sub = join(localesDir, folder);
    if (!existsSync(sub)) continue;
    for (const f of readdirSync(sub).filter((f) => f.endsWith(".md")).sort()) {
      const err = (m: string) => errors.push(`locales/${folder}/${f}: ${m}`);
      const original = join(rootDir, folder, f);
      if (!existsSync(original)) { err("no original note with this name"); continue; }
      const en = readFileSync(original, "utf8");
      const tr = readFileSync(join(sub, f), "utf8");
      if (h2(en) !== h2(tr)) err("the ## headings must be identical to the original (the site and the validator match them)");
      if (bag(en, /\]\(([^)\s]+)\)/g) !== bag(tr, /\]\(([^)\s]+)\)/g)) err("link targets must be identical to the original");
      if (bag(en, /\[(CONFIRMED|INDUSTRY PATTERN|SPECULATIVE|EARLIER PASS)\]/g) !== bag(tr, /\[(CONFIRMED|INDUSTRY PATTERN|SPECULATIVE|EARLIER PASS)\]/g)) err("confidence tags must match the original");
      if (lastReadDate(en) !== lastReadDate(tr)) err("the source date line must keep its English phrasing and date");
      if (notVerified(en).length !== notVerified(tr).length) err('the verification log must keep the same "- Not ..." bullets');
      for (const term of glossary) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
        if (re.test(en) && !re.test(tr)) err(`glossary term "${term}" is in the original but missing here; technical terms stay in English`);
      }
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = resolve(fileURLToPath(import.meta.url), "../..");
  const dir = join(here, "systems");
  const errors = [...validateDir(dir), ...validateToolkit(join(here, "toolkit")), ...validateTracks(join(here, "site/src/tracks.json"), dir, join(here, "toolkit")),
    ...validateTranslations(join(here, "locales/pt-BR"), here, JSON.parse(readFileSync(join(here, "schema/glossary.json"), "utf8")))];
  if (errors.length) {
    console.error(errors.map((e) => `✗ ${e}`).join("\n"));
    process.exit(1);
  }
  console.log("✓ all systems valid");
}
