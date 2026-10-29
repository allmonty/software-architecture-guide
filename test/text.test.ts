import { test } from "node:test";
import assert from "node:assert/strict";
import { shortTags, mentionsOf, searchPages, sectionsOf, splitSections } from "../site/src/text.ts";

const md = "# Title\n\nIntro about leases.\n\n## One\n\nThe cache uses a lease token.\n\n### Detail\n\nMore on the cache.\n\n```\n## not a heading\n```\n\n## One\n\nA second section also on the cache cache cache.\n";

test("sections get the same suffixed slugs as the headings", () => {
  assert.deepEqual(sectionsOf(md).map((s) => s.slug), ["one", "detail", "one-2"]);
  assert.deepEqual(splitSections(md).map((c) => c.slug), ["", "one", "one-2"]);
});

test("a mention search ranks sections by how often the term appears", () => {
  assert.deepEqual(mentionsOf(md, "cache").map((s) => s.slug), ["one-2", "one"]);
  assert.deepEqual(mentionsOf(md, "ca"), []);
});

const pages = [
  { id: "a", title: "Distributed Cache", href: "#a", type: "System", markdown: md },
  { id: "b", title: "Other", href: "#b", type: "System", markdown: "# Other\n\n## Leases\n\nA lease expires after ten seconds.\n" },
];

test("search needs every word and ranks heading and title matches higher", () => {
  assert.deepEqual(searchPages(pages, "lease token").map((h) => [h.page.id, h.slug]), [["a", "one"]]);
  const hits = searchPages(pages, "lease");
  assert.equal(hits[0].page.id, "b"); // the heading match wins over a body match
  assert.ok(hits[0].snippet.includes("ten seconds"));
  assert.deepEqual(searchPages(pages, "x"), []);
  assert.deepEqual(searchPages(pages, "zebra"), []);
});

test("shortTags turns written tags, with or without backticks, into the short markers", () => {
  assert.equal(shortTags("Option A `[CONFIRMED]` and [INDUSTRY PATTERN] and `[SPECULATIVE]`"), "Option A [c] and [ip] and [s]");
});
