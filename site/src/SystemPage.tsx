import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { System } from "./data.ts";
import { DiagramView } from "./DiagramView.tsx";
import { systems, toolkitPages } from "./data.ts";
import type { Components } from "react-markdown";

// Notes are plain Markdown written for GitHub: map sibling-note links to site routes, mark the rest as non-navigable,
// show Mermaid source collapsed (the interactive diagram replaces it) and let wide tables scroll.
export const components: Components = {
  a({ href = "", children }) {
    if (/^(https?:|mailto:|#)/.test(href)) return <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{children}</a>;
    const m = href.match(/(?:^|\/)(\d\d-[a-z0-9-]+)\.md/);
    const hit = m && systems.find((s) => s.id === m[1]);
    if (hit) return <a href={`#${hit.id}`}>{children}</a>;
    const tk = href.match(/(?:^|\/)([PCW]\d\d-[a-z0-9-]+)\.md/);
    const tkHit = tk && toolkitPages.find((p) => p.id === tk[1]);
    if (tkHit) return <a href={`#toolkit/${tkHit.id}`}>{children}</a>;
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

export type Mode = "graph" | "split" | "text";

export function SystemPage({
  system,
  initialLevel,
  initialMode,
  initialFocus,
  initialFlow,
  initialStep,
}: {
  system: System;
  initialLevel: "context" | "container" | "component";
  initialMode: Mode;
  initialFocus: string | null;
  initialFlow: string | null;
  initialStep: number;
}) {
  const [mode, setModeState] = useState<Mode>(initialMode);
  // Keep the chosen view in the URL without disturbing the diagram's own parameters.
  const setMode = (m: Mode) => {
    setModeState(m);
    const [id, q = ""] = location.hash.slice(1).split("?");
    const p = new URLSearchParams(q);
    p.set("view", m);
    history.replaceState(null, "", `#${id}?${p}`);
  };
  // The diagram is unmounted in Text view, so it restarts from the URL (level, focus, flow, step) when it returns.
  const live = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const liveLevel = (["context", "container", "component"] as const).find((l) => l === live.get("level")) ?? initialLevel;
  const liveStep = Number(live.get("step"));
  return (
    <main className="system">
      <div className="bar">
        <h1>
          {system.diagram.title}{" "}
          <small className={`kind ${system.diagram.kind}`}>
            {system.diagram.kind === "reference-design" ? "Reference design" : "Real system"}
          </small>
        </h1>
        <div className="modes" role="group" aria-label="View">
          {(["graph", "split", "text"] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "graph" ? "Graph" : m === "split" ? "Split" : "Text"}
            </button>
          ))}
        </div>
      </div>
      <p className="legend muted" hidden={mode === "text"}>
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
      <div className={`split mode-${mode}`}>
        {mode !== "text" && (
          <div className="left">
            <DiagramView
              key={system.id}
              diagram={system.diagram}
              initialFlow={live.get("flow") ?? initialFlow}
              initialStep={Number.isFinite(liveStep) && live.get("step") ? liveStep - 1 : initialStep}
              initialLevel={liveLevel}
              initialFocus={live.get("focus") ?? initialFocus}
            />
          </div>
        )}
        <article className={`notes right${mode === "graph" ? " hidden" : ""}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>{system.markdown}</ReactMarkdown>
        </article>
      </div>
    </main>
  );
}
