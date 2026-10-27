import dagre from "@dagrejs/dagre";

import { NODE_W } from "./nodeSize.ts";
export { NODE_W };

/**
 * Left-to-right layered layout; returns top-left positions keyed by element id.
 * Members of `boundary` are laid out as a compound cluster, so elements outside the boundary
 * never end up inside the dashed box.
 */
export type Dir = "LR" | "TB";
type Pos = Record<string, { x: number; y: number }>;
export type Heights = Record<string, number>;

function dagreLayout(ids: string[], pairs: [string, string][], boundary: string[], dir: Dir, heights: Heights): Pos {
  const g = new dagre.graphlib.Graph({ compound: boundary.length > 0 });
  g.setGraph({ rankdir: dir, nodesep: 28, ranksep: dir === "LR" ? 64 : 56 });
  g.setDefaultEdgeLabel(() => ({}));
  if (boundary.length > 0) g.setNode("__cluster__", {});
  ids.forEach((id) => {
    g.setNode(id, { width: NODE_W, height: heights[id] });
    if (boundary.includes(id)) g.setParent(id, "__cluster__");
  });
  pairs.forEach(([a, b]) => g.setEdge(a, b));
  dagre.layout(g);
  return Object.fromEntries(
    ids.map((id) => {
      const p = g.node(id);
      return [id, { x: p.x - NODE_W / 2, y: p.y - heights[id] / 2 }];
    }),
  );
}

// Rough size of the canvas, used to choose the direction that needs the least shrinking to fit.
const CANVAS = { w: 760, h: 400 };

/** Lay the view out left-to-right and top-to-bottom and keep whichever fills the canvas better. */
export function layout(ids: string[], pairs: [string, string][], heights: Heights, boundary: string[] = []): { pos: Pos; dir: Dir } {
  const scale = (pos: Pos) => {
    const v = Object.values(pos);
    const w = Math.max(...v.map((p) => p.x)) - Math.min(...v.map((p) => p.x)) + NODE_W;
    const h = Math.max(...ids.map((id) => pos[id].y + heights[id])) - Math.min(...v.map((p) => p.y));
    return Math.min(CANVAS.w / w, CANVAS.h / h, 1);
  };
  const lr = dagreLayout(ids, pairs, boundary, "LR", heights);
  const tb = dagreLayout(ids, pairs, boundary, "TB", heights);
  return scale(tb) > scale(lr) * 1.15 ? { pos: tb, dir: "TB" } : { pos: lr, dir: "LR" };
}
