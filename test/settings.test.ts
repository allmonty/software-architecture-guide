import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, SIZE, clampSize, parseSettings, serializeSettings } from "../site/src/settings-core.ts";

// The cookie string a browser would send back for what serializeSettings produced.
const sent = (s: Parameters<typeof serializeSettings>[0]) => serializeSettings(s).split(";")[0];

test("settings survive a cookie round trip", () => {
  const s = { theme: "warm", font: "literata", size: 19, lang: "pt-BR" } as const;
  assert.deepEqual(parseSettings(`a=1; ${sent(s)}; b=2`), s);
});

test("no cookie gives the defaults", () => {
  assert.deepEqual(parseSettings(""), DEFAULTS);
  assert.deepEqual(parseSettings("other=1"), DEFAULTS);
});

test("a broken or hostile cookie value falls back field by field", () => {
  assert.deepEqual(parseSettings("atlas-settings=%7Bnot json"), DEFAULTS);
  const partly = `atlas-settings=${encodeURIComponent(JSON.stringify({ theme: "neon", font: "lexend", size: "big", lang: "fr" }))}`;
  assert.deepEqual(parseSettings(partly), { ...DEFAULTS, font: "lexend" });
});

test("size is rounded and clamped", () => {
  assert.equal(clampSize(2), SIZE.min);
  assert.equal(clampSize(99), SIZE.max);
  assert.equal(clampSize(16.4), 16);
  assert.equal(clampSize(NaN), SIZE.default);
});

test("the cookie lasts a year and is not sent cross-site", () => {
  const c = serializeSettings(DEFAULTS);
  assert.match(c, /Max-Age=31536000/);
  assert.match(c, /SameSite=Lax/);
});
