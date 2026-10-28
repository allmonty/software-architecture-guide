import ReactMarkdown from "react-markdown";
import type { Diagram } from "../../schema/diagram.schema.ts";
import type { LedgerEntry } from "../../schema/trust.ts";
import { STALE_DAYS } from "../../schema/trust.ts";
import { trustOf } from "./data.ts";
import { scrollToSection } from "./sections.tsx";
import { useT } from "./i18n.tsx";

// Where readers report a wrong or outdated statement. Change here if the repository moves.
export const ISSUES_URL = "https://github.com/allmonty/system-design-atlas/issues/new";

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** What a reader needs to judge a page before relying on it. Built from the page, its diagram and its quote ledger. */
export function TrustCard({ id, title, markdown, claims, diagram }: { id: string; title: string; markdown: string; claims: LedgerEntry[]; diagram?: Diagram }) {
  const i = useT();
  const t = trustOf(markdown, claims, diagram);
  const q = t.quotes;
  const history = typeof __NOTE_HISTORY__ === "undefined" ? [] : __NOTE_HISTORY__[id] ?? [];
  const confirmed = claims.filter((c) => c.status === "confirmed");
  const report = `${ISSUES_URL}?title=${encodeURIComponent(`Correction: ${title}`)}&body=${encodeURIComponent(`Page: ${location.href}\n\nWhat is wrong, and the source that says otherwise:\n`)}`;
  return (
    <aside className="trust" aria-label={i.trustAria}>
      <div className="trust-head">
        <strong>{i.trustSummary}</strong>
        {t.lastRead === undefined
          ? <span className="stale">{i.noSourceDate}</span>
          : <span className={t.stale ? "stale" : "fresh"}>{i.sourcesRead(t.lastRead, t.ageDays!, t.stale, STALE_DAYS)}</span>}
      </div>
      <ul className="trust-facts">
        {t.nodes && <li><b>{i.diagramLabel}</b> {i.diagramFacts(t.nodes.confirmed, t.nodes.pattern, t.nodes.speculative)}</li>}
        <li>
          <b>{i.quotationsLabel}</b>{" "}
          {t.quoteTotal === 0 ? i.noQuotations : (
            <>
              {i.quotesPrimary(q.primary)}{q.secondary > 0 && <>, <span className="warn">{i.quotesSecondary(q.secondary)}</span></>}
              {q.manual > 0 && <>, {i.quotesManual(q.manual)}</>}
              {q.unverified > 0 && <>, <span className="warn">{i.quotesUnverified(q.unverified)}</span></>}
              {q.ignored > 0 && <>, {i.quotesIgnored(q.ignored)}</>}.
            </>
          )}
        </li>
      </ul>
      <p className="muted small">{i.quoteCaveat}</p>
      <details>
        <summary>{i.tagsMeaning}</summary>
        <ul>
          <li><b>[CONFIRMED]</b>{i.tagConfirmed}</li>
          <li><b>[INDUSTRY PATTERN]</b>{i.tagPattern}</li>
          <li><b>[SPECULATIVE]</b>{i.tagSpeculative}</li>
          <li>{i.tagKinds}</li>
        </ul>
      </details>
      {t.notVerified.length > 0 && (
        <details>
          <summary>{i.notVerifiedSummary(t.notVerified.length)}</summary>
          <ul>{t.notVerified.map((b) => <li key={b}><ReactMarkdown>{b}</ReactMarkdown></li>)}</ul>
        </details>
      )}
      {history.length > 0 && (
        <details>
          <summary>{i.changeHistory(history[0].date)}</summary>
          <ul>{history.map((h, i) => <li key={i}><span className="muted">{h.date}</span> {h.subject}</li>)}</ul>
          <p className="muted small">{i.historyNote(history.length)}</p>
        </details>
      )}
      {confirmed.length > 0 && (
        <details>
          <summary>{i.evidence(confirmed.length)}</summary>
          <table className="evidence">
            <thead><tr><th>{i.quotation}</th><th>{i.foundIn}</th></tr></thead>
            <tbody>
              {confirmed.map((c, k) => (
                <tr key={`${k}-${c.quote}`}>
                  <td>“{c.quote.length > 170 ? c.quote.slice(0, 167) + "…" : c.quote}”</td>
                  <td>
                    <a href={c.url} target="_blank" rel="noreferrer">{host(c.url ?? "")}</a>{" "}
                    <span className={`pill src-${c.sourceClass ?? "secondary"}`}>{c.sourceClass ?? "secondary"}</span>
                    {c.via === "archive" && <span className="muted small">{i.viaArchive}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <p className="small"><button className="linkish" onClick={() => scrollToSection("verification-log")}>{i.readLog}</button> · <a href={report} target="_blank" rel="noreferrer">{i.reportError}</a></p>
    </aside>
  );
}
