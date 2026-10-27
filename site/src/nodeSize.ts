// A diagram node is as tall as its text needs. The numbers repeat the .c4-body rules in styles.css (padding,
// gap, font sizes, line height) and the node's 2px border; change them together.
export const NODE_W = 220;
const SAFETY = 8; // px taken off the line width so a word that barely fits in the canvas measure still wraps like the browser does
const BORDER = 2, PAD_X = 16, PAD_Y = 16, GAP = 4, LINE = 1.25;
const LABEL = { px: 13.5, font: "700 13.5px system-ui, sans-serif" };
const SMALL = { px: 11, font: "11px system-ui, sans-serif" };
const MIN_H = 80;

// Node text is cut to this length so a long summary cannot make a node huge.
export const shortSummary = (s: string) => (s.length > 80 ? s.slice(0, 77) + "…" : s);

const ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;

/** Number of lines `text` needs at `width`, wrapping at spaces like the browser does; an over-long word wraps by letters. */
export function wrappedLines(text: string, font: { px: number; font: string }, width: number): number {
  // shortcut: without a canvas (tests, server) assume an average glyph is 0.55em wide.
  const measure = (t: string) => { if (ctx) { ctx.font = font.font; return ctx.measureText(t).width; } return t.length * font.px * 0.55; };
  let lines = 1, cur = 0;
  const space = measure(" ");
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = measure(word);
    if (w > width) { lines += Math.ceil((cur ? cur + space + w : w) / width) - (cur ? 0 : 1); cur = (cur + space + w) % width; continue; }
    if (cur && cur + space + w > width) { lines++; cur = w; } else cur = cur ? cur + space + w : w;
  }
  return lines;
}

/** Height in px for a node with this label, type line and summary. */
export function nodeHeight(label: string, type: string, summary: string, border = BORDER): number {
  const inner = NODE_W - 2 * border - 2 * PAD_X - SAFETY;
  const text = wrappedLines(label, LABEL, inner) * LABEL.px * LINE
    + wrappedLines(type, SMALL, inner) * SMALL.px * LINE
    + (summary ? wrappedLines(shortSummary(summary), SMALL, inner) * SMALL.px * LINE : 0);
  const gaps = summary ? 2 * GAP : GAP;
  return Math.max(MIN_H, Math.ceil(2 * border + 2 * PAD_Y + gaps + text) + 4); // +4: slack for rounding differences between canvas and layout
}
