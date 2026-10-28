import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../site/src/${p}`, import.meta.url), "utf8"));
const tracks: { id: string; steps: { ref: string; why?: string }[] }[] = read("tracks.json").tracks;
const trackPt: Record<string, { why?: Record<string, string> }> = read("locales/pt-BR/tracks.json");
const stagePt: Record<string, unknown> = read("locales/pt-BR/stages.json");

test("every English track has a pt-BR overlay, and every step reason is translated", () => {
  for (const t of tracks) {
    assert.ok(trackPt[t.id], `no pt-BR text for track ${t.id}`);
    for (const s of t.steps) assert.equal(!!trackPt[t.id].why?.[s.ref], !!s.why, `${t.id} step ${s.ref}`);
  }
});

test("the pt-BR overlays name no track, step or stage that the English lacks", () => {
  for (const [id, o] of Object.entries(trackPt)) {
    const t = tracks.find((x) => x.id === id);
    assert.ok(t, `unknown track ${id}`);
    for (const ref of Object.keys(o.why ?? {})) assert.ok(t.steps.some((s) => s.ref === ref), `${id} has no step ${ref}`);
  }
  assert.deepEqual(Object.keys(stagePt).sort(), read("stages.json").map((s: { title: string }) => s.title).sort());
});
