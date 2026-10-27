import { useEffect, useMemo, useState } from "react";
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeChange } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import type { Diagram } from "../../schema/diagram.schema.ts";
import { layout, NODE_H, NODE_W } from "./layout.ts";

export function DiagramView({
  diagram,
  initialFlow = null,
  initialStep = 0,
}: {
  diagram: Diagram;
  initialFlow?: string | null;
  initialStep?: number;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const known = diagram.flows.find((f) => f.id === initialFlow);
  const [flowId, setFlowId] = useState<string | null>(known?.id ?? null);
  const [step, setStep] = useState(
    known ? Math.min(Math.max(initialStep, 0), known.steps.length - 1) : 0,
  );
  const flow = diagram.flows.find((f) => f.id === flowId) ?? null;

  const auto = useMemo(() => layout(diagram), [diagram]);
  // Positions the reader dragged; they override the automatic layout until reset.
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const pos = { ...auto, ...moved };
  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === "position" && c.position) setMoved((m) => ({ ...m, [c.id]: c.position! }));
    }
  };
  const current = flow?.steps[step];
  const seen = new Set(flow?.steps.slice(0, step).map((s) => s.edge));

  // Keep the URL in sync so the current step can be copied. replaceState does not fire hashchange.
  useEffect(() => {
    history.replaceState(null, "", `#${diagram.id}${flowId ? `?flow=${flowId}&step=${step + 1}` : ""}`);
  }, [diagram.id, flowId, step]);

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

  const activeEdge = current ? diagram.edges.find((e) => e.id === current.edge) : null;
  const litNodes = new Set(activeEdge ? [activeEdge.from, activeEdge.to] : []);

  const nodes: Node[] = diagram.nodes.map((n) => ({
    id: n.id,
    position: pos[n.id],
    width: NODE_W,
    height: NODE_H,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: { label: n.label },
    className: `kind-${n.kind} conf-${n.confidence.replace(" ", "-")} ${litNodes.has(n.id) ? "lit" : ""} ${selected === n.id ? "sel" : ""}`,
  }));

  const edges: Edge[] = diagram.edges.map((e) => {
    const isCurrent = e.id === current?.edge;
    const dim = flow && !isCurrent && !seen.has(e.id);
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label,
      animated: isCurrent || e.mode === "async",
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `${isCurrent ? "edge-current" : ""} ${dim ? "edge-dim" : ""}`,
      style: e.mode === "async" && !isCurrent ? { strokeDasharray: "5 4" } : undefined,
    };
  });

  const node = diagram.nodes.find((n) => n.id === selected);

  return (
    <div className="diagram">
      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.1}
          nodesDraggable
          onNodesChange={onNodesChange}
          nodesConnectable={false}
          onNodeClick={(_, n) => setSelected(n.id)}
          onPaneClick={() => setSelected(null)}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
        {Object.keys(moved).length > 0 && (
          <button className="reset" onClick={() => setMoved({})}>Reset layout</button>
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
              <button disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
              <button disabled={step === flow.steps.length - 1} onClick={() => setStep(step + 1)}>Next →</button>
            </div>
          )}
        </section>
        <section>
          {node ? (
            <>
              <h2>{node.label}</h2>
              <span className={`badge conf-${node.confidence.replace(" ", "-")}`}>{node.confidence}</span>
              <p>{node.summary}</p>
              {node.details && <ReactMarkdown>{node.details}</ReactMarkdown>}
              {node.sources.length > 0 && (
                <ul className="sources">
                  {node.sources.map((s) => (
                    <li key={s}><a href={s} target="_blank" rel="noreferrer">{new URL(s).hostname}</a></li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">Click a component for details.</p>
          )}
        </section>
      </aside>
    </div>
  );
}
