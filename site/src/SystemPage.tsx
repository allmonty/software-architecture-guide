import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { System } from "./data.ts";
import { DiagramView } from "./DiagramView.tsx";

export function SystemPage({ system }: { system: System }) {
  const [tab, setTab] = useState<"diagram" | "notes">("diagram");
  return (
    <main className="system">
      <div className="bar">
        <h1>{system.diagram.title}</h1>
        <nav>
          <button aria-pressed={tab === "diagram"} onClick={() => setTab("diagram")}>Diagram</button>
          <button aria-pressed={tab === "notes"} onClick={() => setTab("notes")}>Notes</button>
        </nav>
      </div>
      {tab === "diagram" ? (
        <DiagramView key={system.id} diagram={system.diagram} />
      ) : (
        <article className="notes">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{system.markdown}</ReactMarkdown>
        </article>
      )}
    </main>
  );
}
