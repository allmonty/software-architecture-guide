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
  initialLevel,
  initialFocus,
  initialFlow,
  initialStep,
}: {
  system: System;
  initialLevel: "context" | "container" | "component";
  initialFocus: string | null;
  initialFlow: string | null;
  initialStep: number;
}) {
  const [big, setBig] = useState(false);
  return (
    <main className="system">
      <div className="bar">
        <h1>
          {system.diagram.title}{" "}
          <small className={`kind ${system.diagram.kind}`}>
            {system.diagram.kind === "reference-design" ? "Reference design" : "Real system"}
          </small>
        </h1>
      </div>
      <p className="legend muted">
        <span className="chip sw-person">person</span>
        <span className="chip sw-external">external system</span>
        <span className="chip sw-service">service</span>
        <span className="chip sw-data">data store</span>
        <span className="chip sw-queue">queue / log</span>
        <span className="chip sw-edge">edge / CDN</span>
        <span className="chip sw-client">client</span>
        <span className="chip tint">lighter = component</span>
        · Border: solid = confirmed, dashed = industry pattern, dotted = speculative · Lines: dashed = async
      </p>
      {/* Diagram and flows on the left, the full note on the right, each scrolling on its own. */}
      <div className={`split ${big ? "big" : ""}`}>
        <div className="left">
          <DiagramView key={system.id} diagram={system.diagram} initialFlow={initialFlow} initialStep={initialStep} initialLevel={initialLevel} initialFocus={initialFocus} big={big} onToggleBig={() => setBig(!big)} />
        </div>
        <article className="notes right">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{system.markdown}</ReactMarkdown>
        </article>
      </div>
    </main>
  );
}
