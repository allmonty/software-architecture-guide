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
  const system = systems.find((s) => s.id === hash);
  return (
    <>
      <header className="top">
        <a href="#" className="brand">System Design Atlas</a>
        <button onClick={() => toggleTheme()} aria-label="Toggle theme">◐</button>
      </header>
      {system ? <SystemPage system={system} /> : <Home />}
    </>
  );
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
}

function Home() {
  return (
    <main className="home">
      <h1>System design, as diagrams you can walk through</h1>
      {systems.length === 0 && <p>No systems yet.</p>}
      <ul className="cards">
        {systems.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`}>
              <span className="num">{s.id.slice(0, 2)}</span>
              <strong>{s.diagram.title}</strong>
              <small>{s.diagram.kind === "reference-design" ? "Reference design" : "Real system"}</small>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
