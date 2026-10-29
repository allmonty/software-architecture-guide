import { useEffect, useMemo, useState } from "react";
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { rehypeTags, tagComponents } from "./tags.tsx";
import type { Diagram } from "../../schema/diagram.schema.ts";
import { classifySource, type LedgerEntry } from "../../schema/trust.ts";
import { layout, NODE_W } from "./layout.ts";
import { nodeHeight, shortSummary } from "./nodeSize.ts";
import { mentionsOf, scrollToSection } from "./sections.tsx";
import { buildSvg, downloadPng, downloadSvg } from "./export.ts";
import { useT } from "./i18n.tsx";
import { buildView, containersWithComponents, SYSTEM_ID, typeLine, type Element, type Level } from "./c4.ts";

type C4Data = { el: Element; lit: boolean; dir: "LR" | "TB" };

function C4Node({ data }: NodeProps<Node<C4Data>>) {
  const { el } = data;
  return (
    <div className={`c4-body k-${el.kind}`}>
      <Handle type="target" position={data.dir === "TB" ? Position.Top : Position.Left} />
      <strong>{el.label}</strong>
      <em>{typeLine(el)}</em>
      <span>{shortSummary(el.summary)}</span>
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
  claims = [],
  markdown = "",
  selectRequest = null,
}: {
  // Asks the diagram to open an element (clicked in the note). n makes repeated requests for the same id count.
  selectRequest?: { id: string; n: number } | null;
  diagram: Diagram;
  claims?: LedgerEntry[];
  markdown?: string;
  initialFlow?: string | null;
  initialStep?: number;
  initialLevel?: Level;
  initialFocus?: string | null;
}) {
  const t = useT();
  const focusable = useMemo(() => containersWithComponents(diagram), [diagram]);
  const startFocus = focusable.find((n) => n.id === initialFocus)?.id ?? focusable[0]?.id ?? null;
  const [level, setLevel] = useState<Level>(initialLevel === "component" && !startFocus ? "container" : initialLevel);
  const [focus, setFocus] = useState<string | null>(startFocus);
  const [labels, setLabels] = useState(true);
  const [sel, setSel] = useState<{ kind: "el" | "rel"; id: string } | null>(null);
  const known = diagram.flows.find((f) => f.id === initialFlow);
  const [flowId, setFlowId] = useState<string | null>(known?.id ?? null);
  const [step, setStep] = useState(known ? Math.min(Math.max(initialStep, 0), known.steps.length - 1) : 0);
  const flow = diagram.flows.find((f) => f.id === flowId) ?? null;

  const view = useMemo(() => buildView(diagram, level, focus ?? undefined), [diagram, level, focus]);
  const viewKey = `${level}:${level === "component" ? focus : ""}`;
  // Each node is as tall as its text needs.
  const heights = useMemo(() => Object.fromEntries(view.elements.map((e) => [e.id, nodeHeight(e.label, typeLine(e), e.summary, e.role === "system" ? 3 : 2)])), [view]);
  const arranged = useMemo(
    () => layout(view.elements.map((e) => e.id), view.rels.map((r) => [r.from, r.to]), heights, view.boundary?.members ?? []),
    [view, heights],
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

  // A reference clicked in the note opens that element at the level where it is drawn.
  useEffect(() => {
    const node = selectRequest && diagram.nodes.find((n) => n.id === selectRequest.id);
    if (!node) return;
    if (node.c4 === "component" && node.parent && focusable.some((f) => f.id === node.parent)) { setFocus(node.parent); setLevel("component"); }
    else setLevel((l) => (l === "context" ? "container" : l === "component" ? "container" : l));
    setSel({ kind: "el", id: node.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectRequest?.n]);

  const current = flow?.steps[step];
  const here = current ? view.liftEdge(current.edge) : null;
  const seen = new Set(flow?.steps.slice(0, step).map((s) => view.liftEdge(s.edge).rel?.id));
  const activeRel = view.rels.find((r) => r.id === here?.rel?.id);
  const lit = new Set(activeRel ? [activeRel.from, activeRel.to] : here?.inside ? [here.inside.id] : []);

  // Keep the URL in sync so the current view and step can be copied.
  useEffect(() => {
    const q = new URLSearchParams();
    const keep = new URLSearchParams(location.hash.split("?")[1] ?? "");
    if (keep.get("view")) q.set("view", keep.get("view")!);
    if (keep.get("section")) q.set("section", keep.get("section")!);
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
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return; // arrows belong to the control being used
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
    height: heights[el.id],
    data: { el, lit: lit.has(el.id), dir: arranged.dir },
    className: `c4-${el.role} k-${el.kind} conf-${el.confidence.replace(" ", "-")} ${lit.has(el.id) ? "lit" : ""} ${sel?.kind === "el" && sel.id === el.id ? "sel" : ""}`,
  }));
  if (view.boundary && view.boundary.members.length > 0) {
    const ps = view.boundary.members.map((id) => pos(id));
    const x0 = Math.min(...ps.map((p) => p.x)) - PAD, y0 = Math.min(...ps.map((p) => p.y)) - PAD - 14;
    const x1 = Math.max(...ps.map((p) => p.x)) + NODE_W + PAD, y1 = Math.max(...view.boundary.members.map((id) => pos(id).y + heights[id])) + PAD;
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
      id: r.id, source: r.from, target: r.to, label: labels ? r.label : undefined, type: "smoothstep",
      animated: isCurrent || r.async,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `${isCurrent ? "edge-current" : ""} ${dim ? "edge-dim" : ""}`,
      style: r.async && !isCurrent ? { strokeDasharray: "5 4" } : undefined,
    };
  });

  // The view exactly as arranged on screen, including any positions the reader dragged.
  const exportData = () => {
    const levelName = LEVELS.find((l) => l.id === level)!.name.replace(/^\d · /, "");
    const where = level === "component" && focus ? ` · ${levelName}: ${label(focus)}` : ` · ${levelName}`;
    const built = buildSvg({ title: `${diagram.title}${where}`, elements: view.elements, rels: view.rels, pos, heights, boundary: view.boundary, showLabels: labels });
    return { ...built, name: `${diagram.id}-${level}${level === "component" && focus ? `-${focus}` : ""}` };
  };

  const selEl = sel?.kind === "el" ? view.elements.find((e) => e.id === sel.id) : undefined;
  const selRel = sel?.kind === "rel" ? view.rels.find((r) => r.id === sel.id) : undefined;
  const label = (id: string) => view.elements.find((e) => e.id === id)?.label ?? id;
  const nodeQuotes = selEl?.node ? claims.filter((c) => c.status === "confirmed" && c.url && selEl.node!.sources.includes(c.url)) : [];
  const mentions = selEl && selEl.id !== SYSTEM_ID ? mentionsOf(markdown, selEl.label.replace(/\s*\(.*$/, "")) : [];
  const kids = selEl?.node ? diagram.nodes.filter((n) => n.parent === selEl.node!.id) : [];

  return (
    <div className="diagram-col">
      <div className={`canvas${flow?.failure ? " failure" : ""}`}>
        <div className="levels">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              aria-pressed={level === l.id}
              disabled={l.id === "component" && focusable.length === 0}
              title={l.id === "component" && focusable.length === 0 ? t.noComponentView : undefined}
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
        <div className="tools">
          <button aria-pressed={labels} onClick={() => setLabels(!labels)} title={t.lineLabelsTitle}>{t.lineLabels}</button>
          <button onClick={() => { const x = exportData(); downloadSvg(x.name, x.svg); }} title={t.svgTitle}>SVG</button>
          <button onClick={() => { const x = exportData(); downloadPng(x.name, x.svg, x.width, x.height); }} title={t.pngTitle}>PNG</button>
        </div>
        {Object.keys(mv).length > 0 && (
          <button className="reset" onClick={() => setMoved((m) => ({ ...m, [viewKey]: {} }))}>{t.resetLayout}</button>
        )}
      </div>
      <aside className="panel">
        <section>
          <h2>{t.flows}</h2>
          <div className="flows">
            {diagram.flows.map((f) => (
              <button
                key={f.id}
                aria-pressed={f.id === flowId}
                className={f.failure ? "flow-failure" : undefined}
                title={f.failure ? t.failureTitle : undefined}
                onClick={() => { setFlowId(f.id === flowId ? null : f.id); setStep(0); }}
              >
                {f.name}
              </button>
            ))}
            {diagram.flows.length === 0 && <p className="muted">{t.noFlows}</p>}
          </div>
          {flow && current && (
            <div className={`stepper${flow.failure ? " failure" : ""}`}>
              <p className="caption">
                <b>{t.step(step + 1, flow.steps.length)}</b> {current.caption}
              </p>
              {here?.inside && <p className="muted caption">{t.happensInside(here.inside.label)}</p>}
              {!here?.rel && !here?.inside && <p className="muted caption">{t.notDrawn}</p>}
              <button disabled={step === 0} onClick={() => setStep(step - 1)}>{t.back}</button>
              <button disabled={step === flow.steps.length - 1} onClick={() => setStep(step + 1)}>{t.next}</button>
              <span className="muted small hint">{t.arrowKeys}</span>
              <ol className="step-list">
                {flow.steps.map((st, i) => (
                  <li key={i} className={i === step ? "now" : i < step ? "past" : ""} aria-current={i === step ? "step" : undefined}>
                    <button className="linkish" onClick={() => setStep(i)}>{st.caption}</button>
                  </li>
                ))}
              </ol>
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
              {selEl.node?.details && <ReactMarkdown rehypePlugins={[rehypeTags]} components={tagComponents}>{selEl.node.details}</ReactMarkdown>}
              {selEl.id === SYSTEM_ID && <button onClick={() => setLevel("container")}>{t.openContainers}</button>}
              {kids.length > 0 && (
                <>
                  <p className="muted">{t.componentsOf} {kids.map((k) => k.label).join(", ")}</p>
                  <button onClick={() => { setFocus(selEl.node!.id); setLevel("component"); setSel(null); }}>{t.openComponents}</button>
                </>
              )}
              {selEl.node && selEl.node.sources.length > 0 && (
                <ul className="sources">
                  {selEl.node.sources.map((s) => (
                    <li key={s}><a href={s} target="_blank" rel="noreferrer">{new URL(s).hostname}</a> <span className={`pill src-${classifySource(s)}`}>{classifySource(s)}</span></li>
                  ))}
                </ul>
              )}
              {nodeQuotes.length > 0 && (
                <details>
                  <summary>{t.quotesFrom(nodeQuotes.length)}</summary>
                  <p className="muted small">{t.quotesNote}</p>
                  <ul>{nodeQuotes.map((c, i) => <li key={`${i}-${c.quote}`}>“{c.quote}”</li>)}</ul>
                </details>
              )}
              {mentions.length > 0 && (
                <p className="small">{t.discussedIn} {mentions.map((m, i) => <span key={m.slug}>{i > 0 && " · "}<button className="linkish" onClick={() => scrollToSection(m.slug)}>{m.text}</button></span>)}</p>
              )}
            </>
          ) : selRel ? (
            <>
              <h2>{label(selRel.from)} → {label(selRel.to)}</h2>
              <p className="muted">{selRel.edgeIds.length > 1 ? t.rolledUp : t.interaction}</p>
              <ul>
                {selRel.edgeIds.map((id) => {
                  const e = diagram.edges.find((x) => x.id === id)!;
                  const n = (i: string) => diagram.nodes.find((x) => x.id === i)?.label ?? i;
                  return <li key={id}>{n(e.from)} → {n(e.to)}: {e.label ?? ""}{e.protocol ? ` (${e.protocol})` : ""}{e.mode === "async" ? " · async" : ""}</li>;
                })}
              </ul>
            </>
          ) : (
            <p className="muted">{t.clickForDetails}</p>
          )}
        </section>
      </aside>
    </div>
  );
}
