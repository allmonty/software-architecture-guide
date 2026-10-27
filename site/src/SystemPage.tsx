import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { System } from "./data.ts";
import { DiagramView } from "./DiagramView.tsx";

export function SystemPage({
  system,
  initialFlow,
  initialStep,
}: {
  system: System;
  initialFlow: string | null;
  initialStep: number;
}) {
  const [tab, setTab] = useState<"diagram" | "notes">("diagram");
  return (
    <main className="system">
      <div className="bar">
        <h1>
          {system.diagram.title}{" "}
          <small className={`kind ${system.diagram.kind}`}>
            {system.diagram.kind === "reference-design" ? "Reference design" : "Real system"}
          </small>
        </h1>
        <nav>
          <button aria-pressed={tab === "diagram"} onClick={() => setTab("diagram")}>Diagram</button>
          <button aria-pressed={tab === "notes"} onClick={() => setTab("notes")}>Notes</button>
        </nav>
      </div>
      {tab === "diagram" && (
        <p className="legend muted">
          Colour = kind
          {(["client", "edge", "service", "datastore", "queue", "external"] as const).map((k) => (
            <span key={k} className={`chip kind-${k}`}>{k}</span>
          ))}
          · Border: solid = confirmed, dashed = industry pattern, dotted = speculative
        </p>
      )}
      {tab === "diagram" ? (
        <DiagramView key={system.id} diagram={system.diagram} initialFlow={initialFlow} initialStep={initialStep} />
      ) : (
        <article className="notes">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{system.markdown}</ReactMarkdown>
        </article>
      )}
    </main>
  );
}
