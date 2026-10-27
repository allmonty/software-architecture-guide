import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { System } from "./data.ts";
import { DiagramView } from "./DiagramView.tsx";
import { systems } from "./data.ts";
import type { Components } from "react-markdown";

// Notes are plain Markdown written for GitHub: map sibling-note links to site routes, mark the rest as non-navigable,
// show Mermaid source collapsed (the interactive diagram replaces it) and let wide tables scroll.
const components: Components = {
  a({ href = "", children }) {
    if (/^(https?:|mailto:|#)/.test(href)) return <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{children}</a>;
    const m = href.match(/(?:^|\/)(\d\d-[a-z0-9-]+)\.md/);
    const hit = m && systems.find((s) => s.id === m[1]);
    if (hit) return <a href={`#${hit.id}`}>{children}</a>;
    return <span className="deadlink" title={`Lives in the repository: ${href}`}>{children}</span>;
  },
  table: ({ children }) => <div className="tablewrap"><table>{children}</table></div>,
  pre({ children }) {
    const child = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string; children?: unknown } } | undefined;
    if (child?.props?.className?.includes("language-mermaid")) {
      return <details><summary>Mermaid source (see the Diagram tab)</summary><pre>{child.props.children as string}</pre></details>;
    }
    return <pre>{children}</pre>;
  },
};

export function SystemPage({
  system,
  initialTab,
  initialLevel,
  initialFocus,
  initialFlow,
  initialStep,
}: {
  system: System;
  initialTab: "diagram" | "notes";
  initialLevel: "context" | "container" | "component";
  initialFocus: string | null;
  initialFlow: string | null;
  initialStep: number;
}) {
  const [tab, setTab] = useState<"diagram" | "notes">(initialTab);
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
          C4:
          {(["person", "external-system", "container", "component"] as const).map((k) => (
            <span key={k} className={`chip c4-${k}`}>{k === "external-system" ? "external system" : k}</span>
          ))}
          · Border: solid = confirmed, dashed = industry pattern, dotted = speculative · Lines: dashed = async
        </p>
      )}
      {tab === "diagram" ? (
        <DiagramView key={system.id} diagram={system.diagram} initialFlow={initialFlow} initialStep={initialStep} initialLevel={initialLevel} initialFocus={initialFocus} />
      ) : (
        <article className="notes">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{system.markdown}</ReactMarkdown>
        </article>
      )}
    </main>
  );
}
