import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_SECTIONS, validateDir } from "../scripts/validate.ts";

const md = `# 99 — Toy System\n\n${REQUIRED_SECTIONS.map((s) => `## ${s}\n`).join("\n")}`;
const good = () => ({
  id: "99-toy",
  title: "Toy System",
  kind: "reference-design",
  nodes: [
    { id: "a", label: "A", kind: "client", summary: "s", confidence: "SPECULATIVE", sources: [] },
    { id: "b", label: "B", kind: "service", summary: "s", confidence: "CONFIRMED", sources: ["https://example.com"] },
  ],
  edges: [{ id: "a-b", from: "a", to: "b" }],
  flows: [{ id: "f", name: "F", steps: [{ edge: "a-b", caption: "go" }] }],
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
