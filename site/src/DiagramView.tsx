import { useEffect, useMemo, useState } from "react";
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import type { Diagram } from "../../schema/diagram.schema.ts";
import { layout, NODE_H, NODE_W } from "./layout.ts";
import { buildView, containersWithComponents, SYSTEM_ID, typeLine, type Element, type Level } from "./c4.ts";

type C4Data = { el: Element; lit: boolean; dir: "LR" | "TB" };

function C4Node({ data }: NodeProps<Node<C4Data>>) {
  const { el } = data;
  return (
    <div className={`c4-body k-${el.kind}`}>
      <Handle type="target" position={data.dir === "TB" ? Position.Top : Position.Left} />
      <strong>{el.label}</strong>
      <em>{typeLine(el)}</em>
      <span>{el.summary.length > 80 ? el.summary.slice(0, 77) + "…" : el.summary}</span>
      <Handle type="source" position={data.dir === "TB" ? Position.Bottom : Position.Right} />
    </div>
  );
}
const Boundary = ({ data }: NodeProps<Node<{ label: string }>>) => <div className="boundary-label">{data.label}</div>;
const nodeTypes = { c4: C4Node, boundary: Boundary };

const PAD = 34;
const LEVELS: { id: Level; name: string }[] = [
  { id: "context", name: "1 · Context" },
  { id: "container", name: "2 · Containers" },
  { id: "component", name: "3 · Components" },
];

export function DiagramView({
  diagram,
  initialFlow = null,
  initialStep = 0,
  initialLevel = "container",
  initialFocus = null,
}: {
  diagram: Diagram;
  initialFlow?: string | null;
  initialStep?: number;
  initialLevel?: Level;
  initialFocus?: string | null;
}) {
  const focusable = useMemo(() => containersWithComponents(diagram), [diagram]);
  const startFocus = focusable.find((n) => n.id === initialFocus)?.id ?? focusable[0]?.id ?? null;
  const [level, setLevel] = useState<Level>(initialLevel === "component" && !startFocus ? "container" : initialLevel);
  const [focus, setFocus] = useState<string | null>(startFocus);
  const [sel, setSel] = useState<{ kind: "el" | "rel"; id: string } | null>(null);
  const known = diagram.flows.find((f) => f.id === initialFlow);
  const [flowId, setFlowId] = useState<string | null>(known?.id ?? null);
  const [step, setStep] = useState(known ? Math.min(Math.max(initialStep, 0), known.steps.length - 1) : 0);
  const flow = diagram.flows.find((f) => f.id === flowId) ?? null;

  const view = useMemo(() => buildView(diagram, level, focus ?? undefined), [diagram, level, focus]);
  const viewKey = `${level}:${level === "component" ? focus : ""}`;
  const arranged = useMemo(
    () => layout(view.elements.map((e) => e.id), view.rels.map((r) => [r.from, r.to]), view.boundary?.members ?? []),
    [view],
  );
  // Positions the reader dragged, per view. They override the automatic layout until reset.
  const [moved, setMoved] = useState<Record<string, Record<string, { x: number; y: number }>>>({});
  const mv = moved[viewKey] ?? {};
  const auto = arranged.pos;
  const pos = (id: string) => mv[id] ?? auto[id];
  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === "position" && c.position && c.id !== "__boundary__") {
        const p = c.position;
        setMoved((m) => ({ ...m, [viewKey]: { ...(m[viewKey] ?? {}), [c.id]: p } }));
      }
    }
  };

  const current = flow?.steps[step];
  const here = current ? view.liftEdge(current.edge) : null;
  const seen = new Set(flow?.steps.slice(0, step).map((s) => view.liftEdge(s.edge).rel?.id));
  const activeRel = view.rels.find((r) => r.id === here?.rel?.id);
  const lit = new Set(activeRel ? [activeRel.from, activeRel.to] : here?.inside ? [here.inside.id] : []);

  // Keep the URL in sync so the current view and step can be copied.
  useEffect(() => {
    const q = new URLSearchParams();
    const view = new URLSearchParams(location.hash.split("?")[1] ?? "").get("view");
    if (view) q.set("view", view);
    q.set("level", level);
    if (level === "component" && focus) q.set("focus", focus);
    if (flowId) { q.set("flow", flowId); q.set("step", String(step + 1)); }
    history.replaceState(null, "", `#${diagram.id}?${q}`);
  }, [diagram.id, level, focus, flowId, step]);

  // ← / → walk through the active flow.
  useEffect(() => {
    if (!flow) return;
    const on = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return; // leave browser shortcuts alone
      if (e.key === "ArrowRight") setStep((s) => Math.min(s + 1, flow.steps.length - 1));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [flow]);

  const nodes: Node[] = view.elements.map((el) => ({
    id: el.id,
    type: "c4",
    position: pos(el.id),
    width: NODE_W,
    height: NODE_H,
    data: { el, lit: lit.has(el.id), dir: arranged.dir },
    className: `c4-${el.role} k-${el.kind} conf-${el.confidence.replace(" ", "-")} ${lit.has(el.id) ? "lit" : ""} ${sel?.kind === "el" && sel.id === el.id ? "sel" : ""}`,
  }));
  if (view.boundary && view.boundary.members.length > 0) {
    const ps = view.boundary.members.map((id) => pos(id));
    const x0 = Math.min(...ps.map((p) => p.x)) - PAD, y0 = Math.min(...ps.map((p) => p.y)) - PAD - 14;
    const x1 = Math.max(...ps.map((p) => p.x)) + NODE_W + PAD, y1 = Math.max(...ps.map((p) => p.y)) + NODE_H + PAD;
    nodes.unshift({
      id: "__boundary__", type: "boundary", position: { x: x0, y: y0 }, width: x1 - x0, height: y1 - y0,
      data: { label: view.boundary.label }, draggable: false, selectable: false, focusable: false, zIndex: -1,
      style: { width: x1 - x0, height: y1 - y0 },
    });
  }

  const edges: Edge[] = view.rels.map((r) => {
    const isCurrent = r.id === activeRel?.id;
    const dim = flow && !isCurrent && !seen.has(r.id);
    return {
      id: r.id, source: r.from, target: r.to, label: r.label, type: "smoothstep",
      animated: isCurrent || r.async,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `${isCurrent ? "edge-current" : ""} ${dim ? "edge-dim" : ""}`,
      style: r.async && !isCurrent ? { strokeDasharray: "5 4" } : undefined,
    };
  });

  const selEl = sel?.kind === "el" ? view.elements.find((e) => e.id === sel.id) : undefined;
  const selRel = sel?.kind === "rel" ? view.rels.find((r) => r.id === sel.id) : undefined;
  const label = (id: string) => view.elements.find((e) => e.id === id)?.label ?? id;
  const kids = selEl?.node ? diagram.nodes.filter((n) => n.parent === selEl.node!.id) : [];

  return (
    <div className="diagram-col">
      <div className="canvas">
        <div className="levels">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              aria-pressed={level === l.id}
              disabled={l.id === "component" && focusable.length === 0}
              title={l.id === "component" && focusable.length === 0 ? "This system has no component view" : undefined}
              onClick={() => { setLevel(l.id); setSel(null); }}
            >
              {l.name}
            </button>
          ))}
          {level === "component" && focus && (
            <select value={focus} onChange={(e) => { setFocus(e.target.value); setSel(null); }} aria-label="Container">
              {focusable.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          )}
        </div>
        <ReactFlow
          key={viewKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.1}
          nodesDraggable
          onNodesChange={onNodesChange}
          nodesConnectable={false}
          onNodeClick={(_, n) => n.id !== "__boundary__" && setSel({ kind: "el", id: n.id })}
          onEdgeClick={(_, e) => setSel({ kind: "rel", id: e.id })}
          onPaneClick={() => setSel(null)}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
        {Object.keys(mv).length > 0 && (
          <button className="reset" onClick={() => setMoved((m) => ({ ...m, [viewKey]: {} }))}>Reset layout</button>
        )}
      </div>
      <aside className="panel">
        <section>
          <h2>Flows</h2>
          <div className="flows">
            {diagram.flows.map((f) => (
              <button
                key={f.id}
                aria-pressed={f.id === flowId}
                onClick={() => { setFlowId(f.id === flowId ? null : f.id); setStep(0); }}
              >
                {f.name}
              </button>
            ))}
            {diagram.flows.length === 0 && <p className="muted">No flows for this system.</p>}
          </div>
          {flow && current && (
            <div className="stepper">
              <p className="caption">
                <b>Step {step + 1}/{flow.steps.length}.</b> {current.caption}
              </p>
              {here?.inside && <p className="muted caption">Happens inside <b>{here.inside.label}</b> at this level. Open a lower level to see it.</p>}
              {!here?.rel && !here?.inside && <p className="muted caption">Not drawn in this view.</p>}
              <button disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
              <button disabled={step === flow.steps.length - 1} onClick={() => setStep(step + 1)}>Next →</button>
            </div>
          )}
        </section>
        <section>
          {selEl ? (
            <>
              <h2>{selEl.label}</h2>
              <p className="muted">{typeLine(selEl)}</p>
              {selEl.id !== SYSTEM_ID && (
                <span className={`badge conf-${selEl.confidence.replace(" ", "-")}`}>{selEl.confidence}</span>
              )}
              <p>{selEl.summary}</p>
              {selEl.node?.details && <ReactMarkdown>{selEl.node.details}</ReactMarkdown>}
              {selEl.id === SYSTEM_ID && <button onClick={() => setLevel("container")}>Open the Containers view</button>}
              {kids.length > 0 && (
                <>
                  <p className="muted">Components: {kids.map((k) => k.label).join(", ")}</p>
                  <button onClick={() => { setFocus(selEl.node!.id); setLevel("component"); setSel(null); }}>Open the Components view</button>
                </>
              )}
              {selEl.node && selEl.node.sources.length > 0 && (
                <ul className="sources">
                  {selEl.node.sources.map((s) => (
                    <li key={s}><a href={s} target="_blank" rel="noreferrer">{new URL(s).hostname}</a></li>
                  ))}
                </ul>
              )}
            </>
          ) : selRel ? (
            <>
              <h2>{label(selRel.from)} → {label(selRel.to)}</h2>
              <p className="muted">{selRel.edgeIds.length > 1 ? "Rolled up from these interactions" : "Interaction"}</p>
              <ul>
                {selRel.edgeIds.map((id) => {
                  const e = diagram.edges.find((x) => x.id === id)!;
                  const n = (i: string) => diagram.nodes.find((x) => x.id === i)?.label ?? i;
                  return <li key={id}>{n(e.from)} → {n(e.to)}: {e.label ?? ""}{e.protocol ? ` (${e.protocol})` : ""}{e.mode === "async" ? " · async" : ""}</li>;
                })}
              </ul>
            </>
          ) : (
            <p className="muted">Click an element or a line for details. Drag elements to untangle.</p>
          )}
        </section>
      </aside>
    </div>
  );
}
