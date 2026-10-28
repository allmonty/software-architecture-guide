import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { systems, toolkitPages, type ToolkitPage } from "./data.ts";
import { Home } from "./Home.tsx";
import { TrackPage } from "./TrackPage.tsx";
import { StudyToggle } from "./StudyToggle.tsx";
import { SystemPage, components } from "./SystemPage.tsx";
import { Outline, scrollToSection, useHeadingComponents } from "./sections.tsx";
import { ConceptsPage } from "./ConceptsPage.tsx";
import { ReadingTools } from "./ReadingTools.tsx";
import { TrustCard } from "./TrustCard.tsx";
import { SettingsMenu } from "./SettingsMenu.tsx";
import { useT } from "./i18n.tsx";

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
  const t = useT();
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
        <div className="top-actions">
          <a className="coffee" href="https://buymeacoffee.com/allmonty" target="_blank" rel="noreferrer" title={t.coffeeTitle}>
            <span aria-hidden="true">☕</span> <span className="coffee-text">{t.brandCoffee}</span>
          </a>
          <SettingsMenu />
        </div>
      </header>
      {id === "concepts" ? (
        <ConceptsPage focus={params.get("c")} />
      ) : trackId ? (
        <TrackPage id={trackId} />
      ) : page ? (
        <ToolkitView key={page.id} page={page} section={params.get("section")} />
      ) : system ? (
        <SystemPage
          key={`${system.id}?${query}`}
          system={system}
          initialLevel={(["context", "container", "component"] as const).find((l) => l === params.get("level")) ?? "container"}
          initialMode={(["graph", "split", "text"] as const).find((m) => m === params.get("view")) ?? "split"}
          initialFocus={params.get("focus")}
          initialFlow={params.get("flow")}
          initialStep={Number.isFinite(Number(params.get("step"))) ? Number(params.get("step")) - 1 : 0}
          initialSection={params.get("section")}
        />
      ) : (
        <Home />
      )}
    </>
  );
}

function ToolkitView({ page, section }: { page: ToolkitPage; section: string | null }) {
  const t = useT();
  const headings = useHeadingComponents(page.markdown);
  useEffect(() => { if (section) scrollToSection(section, false); }, [section]);
  return (
    <main className="notes toolkit">
      <p className="crumbs"><a href="#">{t.home}</a> · <a href="#toolkit/README">{t.toolkitIndex}</a><ReadingTools />{page.id !== "README" && <StudyToggle refId={page.id.slice(0, 3)} />}</p>
      <Outline markdown={page.markdown} variant="select" />
      {page.id !== "README" && !page.id.startsWith("W") && <TrustCard id={page.id} title={page.title} markdown={page.markdown} claims={page.claims} />}
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={{ ...components, ...headings }}>{page.markdown}</ReactMarkdown>
    </main>
  );
}
