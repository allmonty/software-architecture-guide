import { resolveRef, tracks, type Item } from "./data.ts";
import { useProgress } from "./progress.ts";
import { ItemRow } from "./Home.tsx";
import { TrackIcon } from "./icons.tsx";

export function TrackPage({ id }: { id: string }) {
  const { done } = useProgress();
  const track = tracks.find((t) => t.id === id);
  if (!track) return <main className="home"><p><a href="#">← Back</a></p><p>Unknown track.</p></main>;
  const steps = track.steps.map((s) => ({ item: resolveRef(s.ref), why: s.why })).filter((x): x is { item: Item; why: string | undefined } => !!x.item);
  const n = steps.filter((s) => done.includes(s.item.ref)).length;
  const nextIndex = steps.findIndex((s) => !done.includes(s.item.ref));
  const mins = steps.reduce((a, s) => a + s.item.minutes, 0);
  const left = steps.filter((s) => !done.includes(s.item.ref)).reduce((a, s) => a + s.item.minutes, 0);
  return (
    <main className="home track">
      <p><a href="#">← All tracks</a></p>
      <h1 className="track-title"><TrackIcon id={track.id} />{track.title}</h1>
      <p className="lede">{track.summary}</p>
      <p className="muted">{track.audience}</p>
      <div className="progress-row">
        <span className="bar-track"><span style={{ width: `${(100 * n) / steps.length}%` }} /></span>
        <span>{n} of {steps.length} done · about {Math.round(left / 60 * 10) / 10} h left of {Math.round(mins / 60)} h</span>
      </div>
      {nextIndex >= 0 && <p><a className="button primary" href={steps[nextIndex].item.href}>{n === 0 ? "Start" : "Continue"}: {steps[nextIndex].item.title}</a></p>}
      {nextIndex < 0 && <p><b>Track complete.</b> Revisit the workbook, or pick another goal from the <a href="#">home page</a>.</p>}
      <ol className="steps">
        {steps.map((s, i) => <ItemRow key={s.item.ref} item={s.item} why={s.why} index={i + 1} next={i === nextIndex} />)}
      </ol>
    </main>
  );
}
