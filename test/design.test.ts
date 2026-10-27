import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The design system (site/src/design.css) owns spacing and radius. Page rules must use its tokens, so the look stays
// consistent. A raw pixel value is allowed only on a line that says why, with a trailing /* raw: reason */ comment.
const css = readFileSync(new URL("../site/src/styles.css", import.meta.url), "utf8");

test("padding, margin, gap and border-radius in styles.css use design tokens", () => {
  const bad: string[] = [];
  css.split("\n").forEach((line, i) => {
    if (/\/\*\s*raw:/.test(line)) return;
    for (const m of line.matchAll(/(?<![-\w])(padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|row-gap|column-gap|border-radius)\s*:\s*([^;}]+)/g)) {
      const value = m[2];
      if (/calc\(/.test(value) || /(^|\s)-\d/.test(value)) continue; // negative offsets and calc() are layout tricks
      if (/(?<![-\w.])[1-9]\d*(\.\d+)?px/.test(value)) bad.push(`styles.css:${i + 1}: ${m[0].trim()}`);
    }
  });
  assert.deepEqual(bad, [], "use var(--s-*) or var(--r-*) from design.css:\n" + bad.join("\n"));
});

test("font sizes in rem come from the type scale", () => {
  const bad = css.split("\n").flatMap((l, i) => (/font-size:\s*[\d.]+rem/.test(l) && !/\/\*\s*raw:/.test(l) ? [`styles.css:${i + 1}: ${l.trim().slice(0, 90)}`] : []));
  assert.deepEqual(bad, [], "use var(--t-*) from design.css:\n" + bad.join("\n"));
});

test("every var(--s-*, --r-*, --t-*) used is defined in design.css", () => {
  const design = readFileSync(new URL("../site/src/design.css", import.meta.url), "utf8");
  const used = new Set([...css.matchAll(/var\((--(?:s|r|t)-[\w]+)\)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !new RegExp(`${v}\\s*:`).test(design));
  assert.deepEqual(missing, []);
});
