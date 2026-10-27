import { useMemo, useState } from "react";
import { resolveRef, systems, toolkitPages, tracks, type Item } from "./data.ts";
import { Backdrop, HeroArt } from "./Art.tsx";
import stages from "./stages.json";
import { searchPages, type SearchPage } from "./text.ts";
import { NamedIcon, TrackIcon } from "./icons.tsx";
import { resetProgress, toggleDone, useProgress } from "./progress.ts";

// Learning stages come from stages.json, the one source of the learning order (README and the atlas track are tested against it).
const STAGES: { title: string; blurb: string; ids: string[] }[] = stages;

const METHOD = [
  ["Read the 60-second summary", "Open a system and read its At a glance box: the key numbers, decisions and common mistakes."],
  ["Try it yourself", "Close the page and sketch your own design for ten minutes, with estimates, before you look further."],
  ["Walk the diagram", "Switch between the Context, Containers and Components levels. Pick a flow and step through it, including the failure flows."],
  ["Read the deep dive", "Compare with the note. Look at the reviewer notes: they list popular claims the sources do not support."],
  ["Drill it", "Do the interview practice section, answer the questions aloud, then add facts you missed to your flashcards."],
];

export function ItemRow({ item, why, index, next }: { item: Item; why?: string; index?: number; next?: boolean }) {
  const { done } = useProgress();
  const isDone = done.includes(item.ref);
  return (
    <li className={`step${isDone ? " done" : ""}${next ? " next" : ""}`}>
      <input type="checkbox" checked={isDone} onChange={() => toggleDone(item.ref)} aria-label={`Mark ${item.title} as studied`} />
      <a href={item.href}>
        <span className="step-top">
          {index !== undefined && <span className="num">{index}</span>}
          <strong>{item.title}</strong>
          <span className={`pill type-${item.type.toLowerCase()}`}>{item.type}</span>
          <span className="muted">{item.minutes > 0 ? `~${item.minutes} min` : "practice"}</span>
          {next && <span className="pill up-next">Up next</span>}
        </span>
        {why && <span className="why">{why}</span>}
      </a>
    </li>
  );
}

export function Home() {
  const { done, last } = useProgress();
  const [q, setQ] = useState("");
  const lastItem = last ? resolveRef(last) : undefined;

  const all = useMemo(() => {
    const items: (Item & { group: string })[] = [];
    for (const g of STAGES) for (const id of g.ids) { const it = resolveRef(id); if (it) items.push({ ...it, group: g.title }); }
    for (const p of toolkitPages) {
      if (p.id === "README") continue;
      const it = resolveRef(p.id.slice(0, 3));
      if (it) items.push({ ...it, group: it.type === "Primer" ? "Primers" : it.type === "Incident" ? "Casebook" : "Workbook" });
    }
    return items;
  }, []);
  const needle = q.trim().toLowerCase();
  const textHits = useMemo(() => (needle.length >= 3 ? searchPages(searchable, needle) : []), [needle]);
  const hits = needle ? all.filter((i) => `${i.title} ${i.ref} ${i.group} ${i.type}`.toLowerCase().includes(needle)) : [];

  const total = all.length;
  const doneCount = all.filter((i) => done.includes(i.ref)).length;

  return (
    <main className="home">
      <Backdrop />
      <section className="hero">
        <div className="hero-text">
          <h1>Learn system design by walking through <span className="grad">worked architectures</span></h1>
          <p className="lede">
            {systems.length} case studies with interactive diagrams, a casebook of real outages, fourteen primers on the topics
            that cut across them, and a practice workbook. Every factual claim is tagged by how well it is supported, and sourced claims link to their source.
          </p>
          <div className="hero-actions">
            <a className="button primary" href="#track/interview">Start the interview track</a>
            <a className="button" href="#track/architect">Become an architect</a>
            {lastItem && <a className="button" href={lastItem.href}>Continue: {lastItem.title}</a>}
          </div>
          <p className="muted small">
            {doneCount > 0 ? `${doneCount} of ${total} pages marked as studied. ` : "Tick pages as you finish them to track progress. "}
            Progress is saved only in this browser.
            {doneCount > 0 && <> <button className="linkish" onClick={() => { if (confirm("Clear all progress in this browser?")) resetProgress(); }}>Reset</button></>}
          </p>
        </div>
        <HeroArt />
      </section>

      <section>
        <h2><NamedIcon name="pick" />1. Pick a goal</h2>
        <p className="muted">Each track is an ordered reading list with a reason for every step. You can switch at any time.</p>
        <ul className="track-cards">
          {tracks.map((t) => {
            const items = t.steps.map((s) => resolveRef(s.ref)).filter((x): x is Item => !!x);
            const n = items.filter((i) => done.includes(i.ref)).length;
            const mins = items.reduce((a, i) => a + i.minutes, 0);
            return (
              <li key={t.id}>
                <a href={`#track/${t.id}`}>
                  <span className="card-head"><TrackIcon id={t.id} /><strong>{t.title}</strong></span>
                  <span className="muted">{t.audience}</span>
                  <span className="card-foot">
                    <span className="meta">{items.length} steps · about {Math.round(mins / 60)} h of reading</span>
                    <span className="bar-track" aria-label={`${n} of ${items.length} done`}><span style={{ width: `${(100 * n) / items.length}%` }} /></span>
                    <span className="meta">{n} of {items.length} done</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2><NamedIcon name="method" />2. How to study one system</h2>
        <ol className="method">
          {METHOD.map(([t, d], i) => (
            <li key={t}><span className="num">{i + 1}</span><div><strong>{t}</strong><span>{d}</span></div></li>
          ))}
        </ol>
        <details className="legend-box">
          <summary>How to read a system page and trust it</summary>
          <ul>
            <li><b>Views:</b> Graph, Split (diagram with the note beside it) or Text. Click a component for its summary, sources and confidence; use ← and → to step through a flow.</li>
            <li><b>Levels:</b> Context shows the system as one box, Containers shows its parts, Components opens one container.</li>
            <li><b>Tags:</b> <b>CONFIRMED</b> was stated by a primary source we read; <b>INDUSTRY PATTERN</b> is standard practice that no source states for this system; <b>SPECULATIVE</b> is plausible or illustrative. Dashed borders mark patterns, dotted ones speculation.</li>
            <li><b>Kinds:</b> a <i>real system</i> is described by its own engineers; a <i>reference design</i> is a standard design built on verified pieces and is not a claim about any company.</li>
            <li>Each note ends with a verification log that says what was checked and what was not.</li>
          </ul>
        </details>
      </section>

      <section>
        <h2><NamedIcon name="browse" />3. Browse everything</h2>
        <p className="muted small">Looking for an idea rather than a system? <a href="#concepts">Browse by concept</a>.</p>
        <input className="search" type="search" placeholder="Search titles and the full text of every note" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        {needle ? (
          <>
            {hits.length > 0 && <><h3>Pages</h3><ul className="steps">{hits.map((i) => <ItemRow key={i.ref} item={i} />)}</ul></>}
            {textHits.length > 0 && (
              <>
                <h3>In the text <span className="muted">({textHits.length}{textHits.length === 30 ? "+" : ""} sections)</span></h3>
                <ul className="text-hits">
                  {textHits.map((h) => (
                    <li key={`${h.page.id}#${h.slug}`}>
                      <a href={`${h.page.href}${h.slug ? `${h.page.href.includes("?") ? "&" : "?"}section=${h.slug}` : ""}`}>
                        <span className="hit-where"><strong>{h.page.title}</strong>{h.heading && <span className="muted"> › {h.heading}</span>}</span>
                        <span className="hit-snippet">{highlight(h.snippet, needle)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {hits.length === 0 && textHits.length === 0 && <p className="muted">{needle.length < 3 ? "Keep typing: the text search starts at three letters." : "No match."}</p>}
          </>
        ) : (
          <>
            {STAGES.map((g) => {
              const items = g.ids.map((id) => resolveRef(id)).filter((x): x is Item => !!x);
              return items.length === 0 ? null : (
                <div key={g.title} className="stage">
                  <h3><NamedIcon name={g.title} />{g.title} <span className="muted">{g.blurb}</span></h3>
                  <ul className="cards">{items.map((i) => <Card key={i.ref} item={i} />)}</ul>
                </div>
              );
            })}
            <div className="stage">
              <h3>Toolkit <span className="muted">Practice material around the systems.</span></h3>
              {(["Incident", "Primer", "Exercise"] as const).map((ty) => (
                <div key={ty}>
                  <h4><NamedIcon name={ty} />{ty === "Incident" ? "Casebook: real incidents" : ty === "Primer" ? "Primers: cross-cutting topics" : "Workbook: practice with feedback"}</h4>
                  <ul className="cards">{all.filter((i) => i.type === ty).map((i) => <Card key={i.ref} item={i} />)}</ul>
                </div>
              ))}
              <p className="muted small"><a href="#toolkit/README">Toolkit index</a></p>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

// Every page the text search covers. Workbook pages are exercises, so they are searched too.
const searchable: SearchPage[] = [
  ...systems.map((s) => ({ id: s.id, title: s.diagram.title, href: `#${s.id}`, type: "System", markdown: s.markdown })),
  ...toolkitPages.filter((p) => p.id !== "README").map((p) => ({ id: p.id, title: p.title, href: `#toolkit/${p.id}`, type: "Toolkit", markdown: p.markdown })),
];

function highlight(text: string, query: string) {
  const words = query.split(/\s+/).filter((w) => w.length >= 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  return text.split(new RegExp(`(${words.join("|")})`, "gi")).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function Card({ item }: { item: Item }) {
  const { done } = useProgress();
  const isDone = done.includes(item.ref);
  return (
    <li>
      <a href={item.href} className={isDone ? "done" : ""}>
        <span className="num">{item.ref}{isDone && <span className="tick" aria-label="studied"> ✓</span>}</span>
        <strong>{item.title}</strong>
        <small className="foot">
          {item.kind && <span className={`kind ${item.kind}`}>{item.kind === "reference-design" ? "Reference design" : "Real system"}</span>}
          <span className="muted">{item.minutes > 0 ? `~${item.minutes} min` : "practice"}</span>
        </small>
      </a>
    </li>
  );
}
