import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeHeight, shortSummary, wrappedLines } from "../site/src/nodeSize.ts";

const f = { px: 13.5, font: "700 13.5px system-ui" };

test("longer text needs more lines, and an over-long word wraps instead of overflowing", () => {
  assert.equal(wrappedLines("Cache", f, 180), 1);
  assert.ok(wrappedLines("Steering + OCA logs (Kafka) and a very long label that cannot fit", f, 180) >= 3);
  assert.ok(wrappedLines("x".repeat(80), f, 180) >= 2);
});

test("a node grows with its label and never drops below the minimum", () => {
  const short = nodeHeight("DB", "[Container: Data store]", "");
  const long = nodeHeight("Distributed coordination, locks and leader election service", "[Container: Service]", "Holds the lock table and issues sequencer tokens to clients");
  assert.ok(short >= 80);
  assert.ok(long > short);
});

test("summaries are cut at 80 characters", () => {
  assert.equal(shortSummary("a".repeat(80)).length, 80);
  assert.equal(shortSummary("a".repeat(81)).length, 78);
});
