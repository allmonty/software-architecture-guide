import { useMemo, useState } from "react";
import { resolveRef, systems, toolkitPages, tracks, type Item } from "./data.ts";
import { Backdrop, HeroArt } from "./Art.tsx";
import stages from "./stages.json";
import { searchPages, type SearchPage } from "./text.ts";
import { NamedIcon, TrackIcon } from "./icons.tsx";
import { resetProgress, toggleDone, useProgress } from "./progress.ts";
import { useT } from "./i18n.tsx";

// Learning stages come from stages.json, the one source of the learning order (README and the atlas track are tested against it).
const STAGES: { title: string; blurb: string; ids: string[] }[] = stages;

export function ItemRow({ item, why, index, next }: { item: Item; why?: string; index?: number; next?: boolean }) {
  const { done } = useProgress();
  const t = useT();
  const isDone = done.includes(item.ref);
  return (
    <li className={`step${isDone ? " done" : ""}${next ? " next" : ""}`}>
      <input type="checkbox" checked={isDone} onChange={() => toggleDone(item.ref)} aria-label={t.markItemStudied(item.title)} />
      <a href={item.href}>
        <span className="step-top">
          {index !== undefined && <span className="num">{index}</span>}
          <strong>{item.title}</strong>
          <span className={`pill type-${item.type.toLowerCase()}`}>{t.itemType[item.type]}</span>
          <span className="muted">{item.minutes > 0 ? t.minutes(item.minutes) : t.practice}</span>
          {next && <span className="pill up-next">{t.upNext}</span>}
        </span>
        {why && <span className="why">{why}</span>}
      </a>
    </li>
  );
}

export function Home() {
  const t = useT();
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
          <h1>{t.heroA}<span className="grad">{t.heroB}</span></h1>
          <p className="lede">{t.lede(systems.length)}</p>
          <div className="hero-actions">
            <a className="button primary" href="#track/interview">{t.startInterview}</a>
            <a className="button" href="#track/architect">{t.becomeArchitect}</a>
            {lastItem && <a className="button" href={lastItem.href}>{t.continueLabel}: {lastItem.title}</a>}
          </div>
          <p className="muted small">
            {doneCount > 0 ? t.progressSome(doneCount, total) : t.progressNone}
            {t.progressLocal}
            {doneCount > 0 && <> <button className="linkish" onClick={() => { if (confirm(t.confirmReset)) resetProgress(); }}>{t.resetProgress}</button></>}
          </p>
        </div>
        <HeroArt />
      </section>

      <section>
        <h2><NamedIcon name="pick" />{t.pickGoal}</h2>
        <p className="muted">{t.pickGoalNote}</p>
        <ul className="track-cards">
          {tracks.map((tr) => {
            const items = tr.steps.map((s) => resolveRef(s.ref)).filter((x): x is Item => !!x);
            const n = items.filter((i) => done.includes(i.ref)).length;
            const mins = items.reduce((a, i) => a + i.minutes, 0);
            return (
              <li key={tr.id}>
                <a href={`#track/${tr.id}`}>
                  <span className="card-head"><TrackIcon id={tr.id} /><strong>{tr.title}</strong></span>
                  <span className="muted">{tr.audience}</span>
                  <span className="card-foot">
                    <span className="meta">{t.trackMeta(items.length, Math.round(mins / 60))}</span>
                    <span className="bar-track" aria-label={t.doneOf(n, items.length)}><span style={{ width: `${(100 * n) / items.length}%` }} /></span>
                    <span className="meta">{t.doneOf(n, items.length)}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2><NamedIcon name="method" />{t.howToStudy}</h2>
        <ol className="method">
          {t.method.map(([t, d], i) => (
            <li key={t}><span className="num">{i + 1}</span><div><strong>{t}</strong><span>{d}</span></div></li>
          ))}
        </ol>
        <details className="legend-box">
          <summary>{t.howToRead}</summary>
          <ul>
            <li>{t.legendViews}</li>
            <li>{t.legendLevels}</li>
            <li>{t.legendTags}</li>
            <li>{t.legendKinds}</li>
            <li>{t.legendLog}</li>
          </ul>
        </details>
      </section>

      <section>
        <h2><NamedIcon name="browse" />{t.browse}</h2>
        <p className="muted small">{t.browseConcept(<a href="#concepts">{t.browseConceptLink}</a>)}</p>
        <input className="search" type="search" placeholder={t.searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t.search} />
        {needle ? (
          <>
            {hits.length > 0 && <><h3>{t.pages}</h3><ul className="steps">{hits.map((i) => <ItemRow key={i.ref} item={i} />)}</ul></>}
            {textHits.length > 0 && (
              <>
                <h3>{t.inText} <span className="muted">({textHits.length}{textHits.length === 30 ? "+" : ""} {t.sections})</span></h3>
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
            {hits.length === 0 && textHits.length === 0 && <p className="muted">{needle.length < 3 ? t.typeMore : t.noMatch}</p>}
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
              <h3>{t.toolkit} <span className="muted">{t.toolkitNote}</span></h3>
              {(["Incident", "Primer", "Exercise"] as const).map((ty) => (
                <div key={ty}>
                  <h4><NamedIcon name={ty} />{ty === "Incident" ? t.casebook : ty === "Primer" ? t.primers : t.workbook}</h4>
                  <ul className="cards">{all.filter((i) => i.type === ty).map((i) => <Card key={i.ref} item={i} />)}</ul>
                </div>
              ))}
              <p className="muted small"><a href="#toolkit/README">{t.toolkitIndex}</a></p>
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
  const t = useT();
  const isDone = done.includes(item.ref);
  return (
    <li>
      <a href={item.href} className={isDone ? "done" : ""}>
        <span className="num">{item.ref}{isDone && <span className="tick" aria-label={t.studiedAria}> ✓</span>}</span>
        <strong>{item.title}</strong>
        <small className="foot">
          {item.kind && <span className={`kind ${item.kind}`}>{item.kind === "reference-design" ? t.referenceDesign : t.realSystem}</span>}
          <span className="muted">{item.minutes > 0 ? t.minutes(item.minutes) : t.practice}</span>
        </small>
      </a>
    </li>
  );
}
