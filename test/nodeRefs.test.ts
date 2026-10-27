import { test } from "node:test";
import assert from "node:assert/strict";
import { rehypeNodeRefs } from "../site/src/nodeRefs.ts";
import { sectionsOf } from "../site/src/text.ts";

const node = (id: string, label: string) => ({ id, label, kind: "service", c4: "container", summary: "s", confidence: "CONFIRMED", sources: [] });
const diagram = { id: "99-x", title: "X", kind: "real-system", nodes: [node("room", "Room"), node("cache", "Cache cluster"), node("a", "Push queue (high)"), node("b", "Push queue (normal)")], edges: [], flows: [] } as never;

const p = (value: string) => ({ type: "root", children: [{ type: "element", tagName: "p", children: [{ type: "text", value }] }] });
const refs = (value: string) => {
  const tree = p(value) as { children: { children: { type: string; properties?: { dataNode?: string }; children?: { value: string }[] }[] }[] };
  rehypeNodeRefs(diagram)()(tree as never);
  return tree.children[0].children.filter((c) => c.type === "element").map((c) => `${c.children![0].value}→${c.properties!.dataNode}`);
};

test("a name links once per section, whatever the capitalisation of a long name", () => {
  assert.deepEqual(refs("The cache cluster serves it. The Cache Cluster again."), ["cache cluster→cache"]);
});

test("a one-word name links only when capitalised like the element, not as an ordinary word", () => {
  assert.deepEqual(refs("There is room here, and a very large room."), []);
  assert.deepEqual(refs("Join a Room first."), ["Room→room"]);
});

test("a name shared by two elements is not linked", () => {
  assert.deepEqual(refs("A push queue fills."), []);
});

test("heading slugs carry their source line, so they do not depend on render order", () => {
  const md = "# T\n\n## One\n\ntext\n\n## One\n";
  assert.deepEqual(sectionsOf(md).map((s) => [s.slug, s.line]), [["one", 3], ["one-2", 7]]);
});
