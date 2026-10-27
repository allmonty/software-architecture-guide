import ReactMarkdown from "react-markdown";
import type { Diagram } from "../../schema/diagram.schema.ts";
import type { LedgerEntry } from "../../schema/trust.ts";
import { STALE_DAYS } from "../../schema/trust.ts";
import { trustOf } from "./data.ts";
import { scrollToSection } from "./sections.tsx";

// Where readers report a wrong or outdated statement. Change here if the repository moves.
export const ISSUES_URL = "https://github.com/allmonty/study/issues/new";

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** What a reader needs to judge a page before relying on it. Built from the page, its diagram and its quote ledger. */
export function TrustCard({ id, title, markdown, claims, diagram }: { id: string; title: string; markdown: string; claims: LedgerEntry[]; diagram?: Diagram }) {
  const t = trustOf(markdown, claims, diagram);
  const q = t.quotes;
  const history = typeof __NOTE_HISTORY__ === "undefined" ? [] : __NOTE_HISTORY__[id] ?? [];
  const confirmed = claims.filter((c) => c.status === "confirmed");
  const report = `${ISSUES_URL}?title=${encodeURIComponent(`Correction: ${title}`)}&body=${encodeURIComponent(`Page: ${location.href}\n\nWhat is wrong, and the source that says otherwise:\n`)}`;
  return (
    <aside className="trust" aria-label="How far to trust this page">
      <div className="trust-head">
        <strong>Trust summary</strong>
        {t.lastRead === undefined
          ? <span className="stale">No source date recorded</span>
          : <span className={t.stale ? "stale" : "fresh"}>Sources read {t.lastRead} ({t.ageDays} days ago){t.stale ? ` · older than ${STALE_DAYS} days, may be out of date` : ""}</span>}
      </div>
      <ul className="trust-facts">
        {t.nodes && <li><b>Diagram:</b> {t.nodes.confirmed} elements confirmed by a source, {t.nodes.pattern} industry pattern{t.nodes.speculative ? `, ${t.nodes.speculative} speculative` : ""}.</li>}
        <li>
          <b>Quotations:</b> {q.primary} found in a primary source{q.secondary > 0 && <>, <span className="warn">{q.secondary} only in a secondary source</span></>}
          {q.manual > 0 && <>, {q.manual} checked by hand (page not machine-readable)</>}
          {q.unverified > 0 && <>, <span className="warn">{q.unverified} not found</span></>}
          {q.ignored > 0 && <>, {q.ignored} short phrases in our own words</>}.
        </li>
      </ul>
      <p className="muted small">A found quotation means the words appear in the cited page. It does not prove that the claim built on them is right; the tags and the reviewer notes carry that judgement.</p>
      <details>
        <summary>What the tags mean</summary>
        <ul>
          <li><b>[CONFIRMED]</b> a primary source we read states it.</li>
          <li><b>[INDUSTRY PATTERN]</b> standard practice that no source states for this system.</li>
          <li><b>[SPECULATIVE]</b> plausible or illustrative, not backed by a source.</li>
          <li><b>Real system</b> is described by its own engineers; a <b>reference design</b> is a standard design and not a claim about any company.</li>
        </ul>
      </details>
      {t.notVerified.length > 0 && (
        <details>
          <summary>What this page says it did not verify ({t.notVerified.length})</summary>
          <ul>{t.notVerified.map((b) => <li key={b}><ReactMarkdown>{b}</ReactMarkdown></li>)}</ul>
        </details>
      )}
      {history.length > 0 && (
        <details>
          <summary>Change history (last change {history[0].date})</summary>
          <ul>{history.map((h, i) => <li key={i}><span className="muted">{h.date}</span> {h.subject}</li>)}</ul>
          <p className="muted small">From the repository's commit log: the latest {history.length} commits to this note's text.</p>
        </details>
      )}
      {confirmed.length > 0 && (
        <details>
          <summary>Quotation evidence ({confirmed.length})</summary>
          <table className="evidence">
            <thead><tr><th>Quotation</th><th>Found in</th></tr></thead>
            <tbody>
              {confirmed.map((c) => (
                <tr key={c.quote}>
                  <td>“{c.quote.length > 170 ? c.quote.slice(0, 167) + "…" : c.quote}”</td>
                  <td>
                    <a href={c.url} target="_blank" rel="noreferrer">{host(c.url ?? "")}</a>{" "}
                    <span className={`pill src-${c.sourceClass ?? "secondary"}`}>{c.sourceClass ?? "secondary"}</span>
                    {c.via === "archive" && <span className="muted small"> via Internet Archive</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <p className="small"><button className="linkish" onClick={() => scrollToSection("verification-log")}>Read the full verification log</button> · <a href={report} target="_blank" rel="noreferrer">Report an error on this page</a></p>
    </aside>
  );
}
