import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_SECTIONS, validateDir, validateToolkit, validateTracks, validateTranslations } from "../scripts/validate.ts";

const md = `# 99 — Toy System\n\n${REQUIRED_SECTIONS.map((s) => `## ${s}\n`).join("\n")}`;
const good = () => ({
  id: "99-toy",
  title: "Toy System",
  kind: "reference-design",
  nodes: [
    { id: "a", label: "A", kind: "client", c4: "person", summary: "s", confidence: "SPECULATIVE", sources: [] },
    { id: "b", label: "B", kind: "service", c4: "container", summary: "s", confidence: "CONFIRMED", sources: ["https://example.com"] },
  ],
  edges: [{ id: "a-b", from: "a", to: "b" }],
  flows: [{ id: "f", name: "F", failure: true, steps: [{ edge: "a-b", caption: "go" }] }],
});

function run(mutate: (d: ReturnType<typeof good>) => void, mdText = md) {
  const dir = mkdtempSync(join(tmpdir(), "sd-"));
  const d = good();
  mutate(d);
  writeFileSync(join(dir, "99-toy.md"), mdText);
  writeFileSync(join(dir, "99-toy.diagram.json"), JSON.stringify(d));
  return validateDir(dir);
}

test("valid system passes", () => assert.deepEqual(run(() => {}), []));

test("edge to unknown node fails", () => {
  const e = run((d) => (d.edges[0].to = "zzz"));
  assert.match(e.join("\n"), /unknown node zzz/);
});

test("a diagram with no failure flow fails", () => {
  const e = run((d) => { (d.flows[0] as { failure?: boolean }).failure = false; });
  assert.match(e.join("\n"), /at least one flow marked failure/);
});

test("flow step with unknown edge fails", () => {
  const e = run((d) => (d.flows[0].steps[0].edge = "nope"));
  assert.match(e.join("\n"), /unknown edge nope/);
});

test("confirmed node without source fails", () => {
  const e = run((d) => (d.nodes[1].sources = []));
  assert.match(e.join("\n"), /needs at least one source/);
});

test("md missing a required section fails", () => {
  const e = run(() => {}, md.replace("## Verification log", ""));
  assert.match(e.join("\n"), /missing section "Verification log"/);
});

test("id must match file stem", () => {
  const e = run((d) => (d.id = "98-toy"));
  assert.match(e.join("\n"), /must equal file stem/);
});

test("broken relative link fails, existing ones pass", () => {
  const e = run(() => {}, md + "\n[gone](./nope.md) [ok](./99-toy.md#x) [web](https://example.com)\n");
  assert.deepEqual(e.filter((m) => m.includes("broken relative link")), ["99-toy: broken relative link: ./nope.md"]);
});

test("component needs a container parent; non-components must not have one", () => {
  const a = run((d) => ((d.nodes[1] as { c4: string }).c4 = "component"));
  assert.match(a.join("\n"), /needs a container parent/);
  const b = run((d) => ((d.nodes[0] as { parent?: string }).parent = "b"));
  assert.match(b.join("\n"), /only components have a parent/);
});

function toolkit(name: string, text: string) {
  const dir = mkdtempSync(join(tmpdir(), "tk-"));
  writeFileSync(join(dir, name), text);
  return validateToolkit(dir);
}
const tkGood = "# P99 — Toy\n\n## Sources and provenance\n\n## ✅ Verification log\n";

test("valid toolkit page passes", () => assert.deepEqual(toolkit("P99-toy.md", tkGood), []));
test("toolkit page needs provenance sections", () => assert.match(toolkit("P99-toy.md", "# P99 — Toy\n").join("\n"), /missing section "Verification log"/));
test("toolkit file names are checked", () => assert.match(toolkit("toy.md", tkGood).join("\n"), /file name must look like/));
test("toolkit broken relative link fails", () => assert.match(toolkit("P99-toy.md", tkGood + "[x](nope.md)\n").join("\n"), /broken relative link/));

function tracks(json: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "tr-"));
  writeFileSync(join(dir, "tracks.json"), JSON.stringify(json));
  writeFileSync(join(dir, "01-toy.md"), "# x");
  writeFileSync(join(dir, "P01-toy.md"), "# x");
  return validateTracks(join(dir, "tracks.json"), dir, dir);
}
test("valid tracks pass", () => assert.deepEqual(tracks({ tracks: [{ id: "a", title: "A", steps: [{ ref: "01" }, { ref: "P01" }] }] }), []));
test("a track step with no page fails", () => assert.match(tracks({ tracks: [{ id: "a", title: "A", steps: [{ ref: "02" }] }] }).join("\n"), /matches no system or toolkit page/));
test("a track listing a step twice fails", () => assert.match(tracks({ tracks: [{ id: "a", title: "A", steps: [{ ref: "01" }, { ref: "01" }] }] }).join("\n"), /lists 01 twice/));

// Translated notes: prose changes, but headings, links, tags, the source date and glossary terms must survive.
const enNote = "# 99 — Toy\n\n**Sources read on 2026-01-02**\n\n## At a glance\n\nKafka and sharding. [CONFIRMED] See [x](https://a.org).\n\n## Verification log\n\n- Not checked: the numbers.\n";
const ptNote = "# 99 — Toy\n\n**Sources read on 2026-01-02**\n\n## At a glance\n\nKafka e sharding. [CONFIRMED] Veja [x](https://a.org).\n\n## Verification log\n\n- Not checked: os números.\n";
function translated(pt: string | null, glossary = ["Kafka", "sharding"]) {
  const root = mkdtempSync(join(tmpdir(), "loc-"));
  mkdirSync(join(root, "systems")); writeFileSync(join(root, "systems", "99-toy.md"), enNote);
  if (pt !== null) { mkdirSync(join(root, "locales/pt-BR/systems"), { recursive: true }); writeFileSync(join(root, "locales/pt-BR/systems", "99-toy.md"), pt); }
  return validateTranslations(join(root, "locales/pt-BR"), root, glossary).join("\n");
}
test("a faithful translation passes", () => assert.equal(translated(ptNote), ""));
test("no locales folder passes", () => assert.equal(translated(null), ""));
test("a translated heading fails", () => assert.match(translated(ptNote.replace("## At a glance", "## Resumo")), /## headings must be identical/));
test("a dropped glossary term fails", () => assert.match(translated(ptNote.replace("sharding", "particionamento")), /glossary term "sharding"/));
test("a changed link, tag or source date fails", () => {
  assert.match(translated(ptNote.replace("https://a.org", "https://b.org")), /link targets/);
  assert.match(translated(ptNote.replace("[CONFIRMED]", "[CONFIRMADO]")), /confidence tags/);
  assert.match(translated(ptNote.replace("read on 2026", "lidas em 2026")), /source date/);
});
test("a translation with no original fails", () => {
  const root = mkdtempSync(join(tmpdir(), "loc-"));
  mkdirSync(join(root, "locales/pt-BR/systems"), { recursive: true }); writeFileSync(join(root, "locales/pt-BR/systems", "99-toy.md"), ptNote);
  assert.match(validateTranslations(join(root, "locales/pt-BR"), root, []).join("\n"), /no original note/);
});
