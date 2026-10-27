import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConcepts } from "../schema/concepts.ts";

test("concept rows become names, slugs and system numbers", () => {
  const md = "# T\n\n## Concept → systems matrix\n\n| Concept | Where |\n|---|---|\n| Caching and request coalescing | 01, 09 |\n| Consensus (Raft) | 33 |\n\n## Next\n| x | 99 |";
  assert.deepEqual(parseConcepts(md), [
    { slug: "caching-and-request-coalescing", name: "Caching and request coalescing", systems: ["01", "09"] },
    { slug: "consensus-raft", name: "Consensus (Raft)", systems: ["33"] },
  ]);
  assert.deepEqual(parseConcepts("no matrix"), []);
});

test("every system in the real README matrix exists", () => {
  const concepts = parseConcepts(readFileSync(new URL("../README.md", import.meta.url), "utf8"));
  assert.ok(concepts.length > 20);
  const slugs = new Set(concepts.map((c) => c.slug));
  assert.equal(slugs.size, concepts.length, "concept slugs must be unique");
  const have = new Set(readFileSync(new URL("../README.md", import.meta.url), "utf8").match(/\b\d\d-[a-z0-9-]+\.md/g)?.map((f) => f.slice(0, 2)));
  for (const c of concepts) for (const n of c.systems) assert.ok(have.has(n), `concept "${c.name}" lists system ${n}, which README does not link to`);
});
