import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { systems, toolkitPages } from "./data.ts";
import { Home } from "./Home.tsx";
import { TrackPage } from "./TrackPage.tsx";
import { StudyToggle } from "./StudyToggle.tsx";
import { SystemPage, components } from "./SystemPage.tsx";

// Hash routing keeps the build deployable on any static host.
const useHash = () => {
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
};

export function App() {
  const hash = useHash();
  // "#07-photo-upload-storage?flow=upload&step=2" deep-links to a flow step.
  const [id, query = ""] = hash.split("?");
  const params = new URLSearchParams(query);
  const system = systems.find((s) => s.id === id);
  const page = id.startsWith("toolkit/") ? toolkitPages.find((p) => p.id === id.slice(8)) : undefined;
  const trackId = id.startsWith("track/") ? id.slice(6) : undefined;
  return (
    <>
      <header className="top">
        <a href="#" className="brand">System Design Atlas</a>
        <button onClick={() => toggleTheme()} aria-label="Toggle theme">◐</button>
      </header>
      {trackId ? (
        <TrackPage id={trackId} />
      ) : page ? (
        <main className="notes toolkit">
          <p className="crumbs"><a href="#">← Home</a> · <a href="#toolkit/README">Toolkit index</a>{page.id !== "README" && <StudyToggle refId={page.id.slice(0, 3)} />}</p>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>{page.markdown}</ReactMarkdown>
        </main>
      ) : system ? (
        <SystemPage
          key={`${system.id}?${query}`}
          system={system}
          initialLevel={(["context", "container", "component"] as const).find((l) => l === params.get("level")) ?? "container"}
          initialMode={(["graph", "split", "text"] as const).find((m) => m === params.get("view")) ?? "split"}
          initialFocus={params.get("focus")}
          initialFlow={params.get("flow")}
          initialStep={Number.isFinite(Number(params.get("step"))) ? Number(params.get("step")) - 1 : 0}
        />
      ) : (
        <Home />
      )}
    </>
  );
}

function toggleTheme() {
  const root = document.documentElement;
  // Before the first click no explicit theme is set, so start from the OS preference.
  const current = root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
}
