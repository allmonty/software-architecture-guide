import dagre from "@dagrejs/dagre";

export const NODE_W = 230;
export const NODE_H = 96;

/**
 * Left-to-right layered layout; returns top-left positions keyed by element id.
 * Members of `boundary` are laid out as a compound cluster, so elements outside the boundary
 * never end up inside the dashed box.
 */
export function layout(
  ids: string[],
  pairs: [string, string][],
  boundary: string[] = [],
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph({ compound: boundary.length > 0 });
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 110 });
  g.setDefaultEdgeLabel(() => ({}));
  if (boundary.length > 0) g.setNode("__cluster__", {});
  ids.forEach((id) => {
    g.setNode(id, { width: NODE_W, height: NODE_H });
    if (boundary.includes(id)) g.setParent(id, "__cluster__");
  });
  pairs.forEach(([a, b]) => g.setEdge(a, b));
  dagre.layout(g);
  return Object.fromEntries(
    ids.map((id) => {
      const p = g.node(id);
      return [id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }];
    }),
  );
}
