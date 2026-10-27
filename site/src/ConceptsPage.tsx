import { useEffect, useState } from "react";
import { concepts, systems } from "./data.ts";

/** The README's concept matrix as a page: pick a concept, see every system that covers it. */
export function ConceptsPage({ focus }: { focus: string | null }) {
  const [q, setQ] = useState("");
  useEffect(() => { if (focus) document.getElementById(focus)?.scrollIntoView({ block: "center" }); }, [focus]);
  const needle = q.trim().toLowerCase();
  const shown = concepts.filter((c) => !needle || c.name.toLowerCase().includes(needle));
  return (
    <main className="home concepts">
      <p><a href="#">← Home</a></p>
      <h1>Browse by concept</h1>
      <p className="lede">The same idea shows up in many systems. Pick a concept to see where it is covered, and compare how each system uses it.</p>
      <input className="search" type="search" placeholder="Filter concepts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter concepts" />
      <ul className="concept-list">
        {shown.map((c) => (
          <li key={c.slug} id={c.slug} className={c.slug === focus ? "focus-row" : ""}>
            <h2>{c.name}</h2>
            <ul className="chips">
              {c.systems.map((n) => {
                const s = systems.find((x) => x.id.startsWith(n + "-"));
                return s && <li key={n}><a href={`#${s.id}`}><span className="num">{n}</span> {s.diagram.title}</a></li>;
              })}
            </ul>
          </li>
        ))}
        {shown.length === 0 && <li className="muted">No concept matches.</li>}
      </ul>
    </main>
  );
}

/** Concepts that cover this system, as links into the concept page. */
export function ConceptChips({ systemId }: { systemId: string }) {
  const mine = concepts.filter((c) => c.systems.includes(systemId.slice(0, 2)));
  if (mine.length === 0) return null;
  return (
    <p className="concept-chips small">
      <span className="muted">Concepts in this note:</span>{" "}
      {mine.map((c) => <a key={c.slug} className="chip" href={`#concepts?c=${c.slug}`}>{c.name}</a>)}
    </p>
  );
}
