import { useEffect, useState } from "react";
import { systems } from "./data.ts";
import { SystemPage } from "./SystemPage.tsx";

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
  return (
    <>
      <header className="top">
        <a href="#" className="brand">System Design Atlas</a>
        <button onClick={() => toggleTheme()} aria-label="Toggle theme">◐</button>
      </header>
      {system ? (
        <SystemPage
          key={`${system.id}?${query}`}
          system={system}
          initialTab={params.get("tab") === "notes" ? "notes" : "diagram"}
          initialLevel={(["context", "container", "component"] as const).find((l) => l === params.get("level")) ?? "container"}
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

// Learning order from the hub README. Systems not listed here still appear under "More".
const PATH: { title: string; ids: string[] }[] = [
  { title: "Foundations", ids: ["01", "02", "03"] },
  { title: "Storage and data infrastructure", ids: ["05", "04", "07", "06"] },
  { title: "Real-time communication", ids: ["08", "09", "18", "21"] },
  { title: "Media delivery", ids: ["14", "12", "13"] },
  { title: "Feeds and notifications", ids: ["11", "10"] },
  { title: "Correctness under contention", ids: ["16", "17", "19"] },
  { title: "Location and discovery", ids: ["15", "20"] },
];

function Card({ s }: { s: (typeof systems)[number] }) {
  return (
    <li>
      <a href={`#${s.id}`}>
        <span className="num">{s.id.slice(0, 2)}</span>
        <strong>{s.diagram.title}</strong>
        <small className={`kind ${s.diagram.kind}`}>
          {s.diagram.kind === "reference-design" ? "Reference design" : "Real system"}
        </small>
      </a>
    </li>
  );
}

function Home() {
  const byNum = new Map(systems.map((s) => [s.id.slice(0, 2), s]));
  const listed = new Set(PATH.flatMap((g) => g.ids));
  const more = systems.filter((s) => !listed.has(s.id.slice(0, 2)));
  return (
    <main className="home">
      <h1>System design, as diagrams you can walk through</h1>
      <p className="muted">
        Click a component for details and sources. Pick a flow and step through it with ← and →.
        Every claim is tagged <b>CONFIRMED</b>, <b>INDUSTRY PATTERN</b> or <b>SPECULATIVE</b>.
      </p>
      {systems.length === 0 && <p>No systems yet.</p>}
      {PATH.map((g) => {
        const items = g.ids.map((n) => byNum.get(n)).filter((x) => x !== undefined);
        return items.length === 0 ? null : (
          <section key={g.title}>
            <h2>{g.title}</h2>
            <ul className="cards">{items.map((s) => <Card key={s.id} s={s} />)}</ul>
          </section>
        );
      })}
      {more.length > 0 && (
        <section>
          <h2>More</h2>
          <ul className="cards">{more.map((s) => <Card key={s.id} s={s} />)}</ul>
        </section>
      )}
    </main>
  );
}
