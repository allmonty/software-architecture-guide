import dagre from "@dagrejs/dagre";
import type { Diagram } from "../../schema/diagram.schema.ts";

export const NODE_W = 190;
export const NODE_H = 60;

/** Left-to-right layered layout; returns top-left positions keyed by node id. */
export function layout(d: Diagram): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  d.nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  d.edges.forEach((e) => g.setEdge(e.from, e.to));
  dagre.layout(g);
  return Object.fromEntries(
    d.nodes.map((n) => {
      const p = g.node(n.id);
      return [n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }];
    }),
  );
}
