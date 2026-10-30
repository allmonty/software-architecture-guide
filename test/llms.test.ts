import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listNotes, llmsTxt } from "../scripts/build-llms.ts";

const root = resolve(import.meta.dirname, "..");
const notes = listNotes(root);
const txt = llmsTxt(notes);

test("llms.txt starts with the H1 and a blockquote", () => {
  const [h1, , quote] = txt.split("\n");
  assert.equal(h1, "# System Design Atlas");
  assert.ok(quote.startsWith("> "));
});

test("llms.txt lists every system and toolkit page, and each target exists", () => {
  assert.ok(notes.filter((n) => n.dir === "systems").length >= 35);
  for (const n of notes) {
    assert.ok(txt.includes(`(md/${n.dir}/${n.file})`), n.file);
    assert.ok(existsSync(resolve(root, n.dir, n.file)));
  }
});
