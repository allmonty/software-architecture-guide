import type { Diagram } from "../../schema/diagram.schema.ts";

export type Level = "context" | "container" | "component";
type DNode = Diagram["nodes"][number];

export const SYSTEM_ID = "__system__";

export interface Element {
  id: string;
  label: string;
  role: "person" | "external-system" | "system" | "container" | "component" | "note";
  kind: DNode["kind"];
  technology?: string;
  summary: string;
  confidence: DNode["confidence"];
  node?: DNode; // absent for the system box itself
}

export interface Rel {
  id: string;
  from: string;
  to: string;
  label: string;
  async: boolean;
  edgeIds: string[]; // underlying diagram edges that were rolled up into this one
}

export interface View {
  elements: Element[];
  rels: Rel[];
  boundary?: { label: string; members: string[] };
  liftEdge: (edgeId: string) => { rel?: Rel; inside?: Element };
}

const KIND_NAME: Record<DNode["kind"], string> = {
  client: "Client",
  edge: "Edge / CDN",
  service: "Service",
  datastore: "Data store",
  queue: "Queue / log",
  external: "External",
};

/** The "[Type: technology]" line C4 puts under an element's name. */
export function typeLine(e: Element): string {
  if (e.role === "person") return "[Person]";
  if (e.role === "system") return "[Software System]";
  if (e.role === "external-system") return "[External System]";
  if (e.role === "note") return "[Note]";
  const what = e.role === "container" ? "Container" : "Component";
  return `[${what}: ${e.technology ?? KIND_NAME[e.kind]}]`;
}

/** Containers that have at least one component, i.e. those with a Components view. */
export function containersWithComponents(d: Diagram): DNode[] {
  const parents = new Set(d.nodes.filter((n) => n.c4 === "component").map((n) => n.parent));
  return d.nodes.filter((n) => n.c4 === "container" && parents.has(n.id));
}

const toElement = (n: DNode): Element => ({
  id: n.id, label: n.label, role: n.c4, kind: n.kind, technology: n.technology,
  summary: n.summary, confidence: n.confidence, node: n,
});

export function buildView(d: Diagram, level: Level, focus?: string): View {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const system: Element = {
    id: SYSTEM_ID, label: d.title, role: "system", kind: "service",
    summary: `The system in scope. Open the Containers view to see what it is made of.`,
    confidence: "INDUSTRY PATTERN",
  };

  // Which element represents a node at this level (null = not shown)?
  const lift = (n: DNode): string | null => {
    if (level === "context") {
      if (n.c4 === "person" || n.c4 === "external-system") return n.id;
      return n.c4 === "note" ? null : SYSTEM_ID;
    }
    if (n.c4 === "component") {
      if (level === "component" && n.parent === focus) return n.id;
      return n.parent ?? null;
    }
    if (n.c4 === "note") return level === "container" ? n.id : null;
    return n.id;
  };

  const focusComponents = new Set(
    level === "component" ? d.nodes.filter((n) => n.c4 === "component" && n.parent === focus).map((n) => n.id) : [],
  );

  const relMap = new Map<string, Rel>();
  for (const e of d.edges) {
    const a = lift(byId.get(e.from)!), b = lift(byId.get(e.to)!);
    if (!a || !b || a === b) continue;
    if (level === "component" && !focusComponents.has(a) && !focusComponents.has(b)) continue;
    const id = `${a}>${b}`;
    const r = relMap.get(id) ?? { id, from: a, to: b, label: "", async: true, edgeIds: [] };
    r.edgeIds.push(e.id);
    r.async = r.async && e.mode === "async";
    relMap.set(id, r);
  }
  const edgeLabel = new Map(d.edges.map((e) => [e.id, e.label ?? ""]));
  for (const r of relMap.values()) {
    const labels = [...new Set(r.edgeIds.map((i) => edgeLabel.get(i)).filter(Boolean))];
    r.label = labels.length > 1 ? `${labels[0]} (+${labels.length - 1})` : (labels[0] ?? "");
  }
  const rels = [...relMap.values()];

  const ids = new Set<string>();
  if (level === "context") {
    ids.add(SYSTEM_ID);
    d.nodes.filter((n) => n.c4 === "person" || n.c4 === "external-system").forEach((n) => ids.add(n.id));
  } else if (level === "container") {
    d.nodes.filter((n) => n.c4 !== "component").forEach((n) => ids.add(n.id));
  } else {
    focusComponents.forEach((i) => ids.add(i));
    rels.forEach((r) => { ids.add(r.from); ids.add(r.to); });
  }

  const elements = [...ids].map((id) => (id === SYSTEM_ID ? system : toElement(byId.get(id)!)));
  const boundary =
    level === "container"
      ? { label: `[Software System] ${d.title}`, members: elements.filter((e) => e.role === "container").map((e) => e.id) }
      : level === "component" && focus
        ? { label: `[Container] ${byId.get(focus)?.label ?? focus}`, members: [...focusComponents] }
        : undefined;

  const relByEdge = new Map<string, Rel>();
  rels.forEach((r) => r.edgeIds.forEach((i) => relByEdge.set(i, r)));
  const liftEdge = (edgeId: string) => {
    const rel = relByEdge.get(edgeId);
    if (rel) return { rel };
    // Not drawn here: either both ends collapse into one element, or the edge is out of scope at this level.
    const e = d.edges.find((x) => x.id === edgeId);
    const a = e && lift(byId.get(e.from)!);
    const b = e && lift(byId.get(e.to)!);
    const hit = a && a === b ? elements.find((x) => x.id === a) : undefined;
    return { inside: hit };
  };
  return { elements, rels, boundary, liftEdge };
}
