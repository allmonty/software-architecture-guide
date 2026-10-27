import { test } from "node:test";
import assert from "node:assert/strict";
import { ageInDays, classifySource, lastReadDate } from "../schema/trust.ts";

test("company and standards sites are primary, explainers are secondary", () => {
  assert.equal(classifySource("https://www.usenix.org/conference/x"), "primary");
  assert.equal(classifySource("https://arxiv.org/abs/2309.06180"), "primary");
  assert.equal(classifySource("https://en.wikipedia.org/wiki/Bloom_filter"), "secondary");
  assert.equal(classifySource("https://newsletter.systemdesign.one/p/x"), "secondary");
  assert.equal(classifySource("https://highscalability.com/x/"), "secondary");
});

test("Medium is primary only for a company engineering blog we name", () => {
  assert.equal(classifySource("https://medium.com/twitch-engineering/post-1"), "primary");
  assert.equal(classifySource("https://medium.com/@someone/post"), "secondary");
});

test("an unparseable URL is not trusted", () => assert.equal(classifySource("not a url"), "secondary"));

test("the newest read date in a note is found", () => {
  const md = "> **Sources read on 2026-03-01:** a\n\nRe-verification (second pass), 2026-05-09\n\nFact-check, 2026-04-02";
  assert.equal(lastReadDate(md), "2026-05-09");
  assert.equal(lastReadDate("no dates here"), undefined);
});

test("age counts whole days", () => assert.equal(ageInDays("2026-01-01", Date.parse("2026-01-11T12:00:00Z")), 10));

import { notVerified, summarizeLedger } from "../schema/trust.ts";

test("ledger entries are tallied by status and source class", () => {
  const t = summarizeLedger([
    { quote: "a", url: "https://arxiv.org/x", sourceClass: "primary", status: "confirmed" },
    { quote: "b", url: "https://en.wikipedia.org/wiki/X", status: "confirmed" },
    { quote: "c", status: "manual" }, { quote: "d", status: "ignored" }, { quote: "e", status: "unverified" },
  ]);
  assert.deepEqual(t, { primary: 1, secondary: 1, manual: 1, ignored: 1, unverified: 1 });
});

test("only the 'Not ...' bullets of the verification log are returned", () => {
  const md = "# T\n\n- Not here\n\n## ✅ Verification log\n\n*date*\n- Verified in the paper: x\n- Not claimed: how it works\n  today at scale\n- **Not re-verified**: older parts\n\n## After\n- Not this one";
  assert.deepEqual(notVerified(md), ["Not claimed: how it works today at scale", "**Not re-verified**: older parts"]);
  assert.deepEqual(notVerified("no log"), []);
});
