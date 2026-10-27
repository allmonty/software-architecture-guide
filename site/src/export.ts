import type { Element, Rel } from "./c4.ts";
import { typeLine } from "./c4.ts";
import { NODE_W } from "./layout.ts";

// Exports the diagram on screen as a standalone SVG (or PNG), for notes and slides. The colours repeat the C4 palette
// in styles.css because an exported file cannot read the page's CSS variables.
const FILL: Record<string, string> = { service: "#1d4ed8", datastore: "#b45309", queue: "#be185d", edge: "#0f766e", client: "#7c3aed", external: "#475569" };
const TINT: Record<string, string> = { service: "#bfdbfe", datastore: "#fde68a", queue: "#fbcfe8", edge: "#99f6e4", client: "#ddd6fe", external: "#e2e8f0" };
const SOLID: Record<string, string> = { person: "#4c1d95", system: "#0f172a", "external-system": "#475569", note: "#6b7280" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wrap = (s: string, n: number) => {
  const lines: string[] = []; let cur = "";
  for (const w of s.split(/\s+/)) { if (cur && (cur + " " + w).length > n) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
};

interface Input {
  title: string; elements: Element[]; rels: Rel[]; pos: (id: string) => { x: number; y: number }; heights: Record<string, number>;
  boundary?: { label: string; members: string[] }; showLabels: boolean;
}

export function buildSvg({ title, elements, rels, pos, heights, boundary, showLabels }: Input): { svg: string; width: number; height: number } {
  const PAD = 34, M = 40, HEAD = 36, FOOT = 26;
  const boxes = elements.map((e) => ({ e, h: heights[e.id], ...pos(e.id) }));
  let minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
  let maxX = Math.max(...boxes.map((b) => b.x + NODE_W)), maxY = Math.max(...boxes.map((b) => b.y + b.h));
  let frame = "";
  if (boundary && boundary.members.length) {
    const ps = boundary.members.map((id) => pos(id));
    const x0 = Math.min(...ps.map((p) => p.x)) - PAD, y0 = Math.min(...ps.map((p) => p.y)) - PAD - 14;
    const x1 = Math.max(...ps.map((p) => p.x)) + NODE_W + PAD, y1 = Math.max(...boundary.members.map((id) => pos(id).y + heights[id])) + PAD;
    minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
    frame = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="10" fill="none" stroke="#6b7280" stroke-width="2" stroke-dasharray="7 6"/><text x="${x0 + 10}" y="${y0 + 20}" font-size="12" font-weight="600" fill="#6b7280">${esc(boundary.label)}</text>`;
  }
  const width = maxX - minX + 2 * M, height = maxY - minY + 2 * M + HEAD + FOOT;
  const ox = M - minX, oy = M + HEAD - minY;
  const at = new Map(boxes.map((b) => [b.e.id, b]));

  // Several lines between the same two boxes (often one each way) are spread sideways so they do not overlap.
  const pairKey = (r: Rel) => [r.from, r.to].sort().join("|");
  const group = new Map<string, Rel[]>();
  for (const r of rels) group.set(pairKey(r), [...(group.get(pairKey(r)) ?? []), r]);
  const edge = rels.map((r) => {
    const a = at.get(r.from), b = at.get(r.to);
    if (!a || !b) return "";
    const mates = group.get(pairKey(r))!;
    const shift = (mates.indexOf(r) - (mates.length - 1) / 2) * 16 * (r.from < r.to ? 1 : -1);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len * shift, ny = (b.x - a.x) / len * shift;
    const ax = a.x + NODE_W / 2 + nx, ay = a.y + a.h / 2 + ny, bx = b.x + NODE_W / 2 + nx, by = b.y + b.h / 2 + ny;
    // Where the centre-to-centre line leaves the first box and enters the second.
    const clip = (cx: number, cy: number, dx: number, dy: number, h: number) => {
      const t = Math.min(dx ? NODE_W / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
      return [cx + dx * t, cy + dy * t];
    };
    const [x1, y1] = clip(ax, ay, bx - ax, by - ay, a.h), [x2, y2] = clip(bx, by, ax - bx, ay - by, b.h);
    const label = showLabels && r.label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}" font-size="11" text-anchor="middle" fill="#111827" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(r.label.length > 40 ? r.label.slice(0, 39) + "…" : r.label)}</text>` : "";
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#374151" stroke-width="1.6" marker-end="url(#arrow)"${r.async ? ' stroke-dasharray="5 4"' : ""}/>${label}`;
  }).join("");

  const nodes = boxes.map(({ e, x, y, h }) => {
    const tint = e.role === "component";
    const fill = e.role === "container" || e.role === "component" ? (tint ? TINT : FILL)[e.kind] : SOLID[e.role];
    const ink = tint ? "#0f172a" : "#ffffff";
    const dash = e.confidence === "INDUSTRY PATTERN" ? ' stroke-dasharray="6 4"' : e.confidence === "SPECULATIVE" ? ' stroke-dasharray="2 4"' : "";
    const lines = wrap(e.label, 24);
    // Centre the label and type line in the box.
    const top = y + (h - (lines.length * 17 + 15)) / 2 + 13;
    const text = lines.map((l, i) => `<text x="${x + NODE_W / 2}" y="${top + i * 17}" font-size="14" font-weight="700" text-anchor="middle" fill="${ink}">${esc(l)}</text>`).join("");
    const sub = `<text x="${x + NODE_W / 2}" y="${top + lines.length * 17 + 2}" font-size="11" font-style="italic" text-anchor="middle" fill="${ink}" opacity=".9">${esc(typeLine(e).slice(0, 34))}</text>`;
    return `<g><rect x="${x}" y="${y}" width="${NODE_W}" height="${h}" rx="9" fill="${fill}" stroke="${tint ? "#0f172a" : "#ffffff"}" stroke-width="2"${dash}/>${text}${sub}</g>`;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">`
    + `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="#374151"/></marker></defs>`
    + `<rect width="100%" height="100%" fill="#ffffff"/>`
    + `<text x="${M}" y="${M - 6}" font-size="18" font-weight="700" fill="#111827">${esc(title)}</text>`
    + `<g transform="translate(${ox} ${oy})">${frame}${edge}${nodes}</g>`
    + `<text x="${M}" y="${height - 12}" font-size="11" fill="#6b7280">Border: solid = confirmed, dashed = industry pattern, dotted = speculative. Lines: dashed = async. System Design Atlas.</text>`
    + `</svg>`;
  return { svg, width, height };
}

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const downloadSvg = (name: string, svg: string) => download(`${name}.svg`, new Blob([svg], { type: "image/svg+xml" }));

export function downloadPng(name: string, svg: string, width: number, height: number) {
  const img = new Image();
  img.onload = () => {
    const scale = 2, c = document.createElement("canvas");
    c.width = width * scale; c.height = height * scale;
    const g = c.getContext("2d")!; g.scale(scale, scale); g.drawImage(img, 0, 0);
    c.toBlob((b) => b && download(`${name}.png`, b));
  };
  img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
}
