import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// stages.json is the one source of the learning order. The atlas track and the README path must follow it.
const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const stages: { ids: string[] }[] = JSON.parse(read("../site/src/stages.json"));
const order = stages.flatMap((s) => s.ids);

test("every system appears in exactly one stage", () => {
  const systems = readdirSync(new URL("../systems/", import.meta.url)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, 2)).sort();
  assert.deepEqual([...order].sort(), systems);
});

test("the atlas track lists the systems in stage order", () => {
  const atlas = JSON.parse(read("../site/src/tracks.json")).tracks.find((t: { id: string }) => t.id === "atlas");
  assert.deepEqual(atlas.steps.map((s: { ref: string }) => s.ref), order);
});

test("the README learning path lists the systems in stage order", () => {
  const readme = read("../README.md");
  const section = readme.slice(readme.indexOf("## Suggested learning path")).split("\n## ")[0];
  const nums = [...section.matchAll(/(?:^\d+\. \*\*[^*]+:\*\* |→ )(\d\d) /gm)].map((m) => m[1]);
  assert.deepEqual(nums, order);
});
