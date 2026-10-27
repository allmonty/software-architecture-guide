# C05 — Knight Capital, 1 August 2012 (a deployment that lost $460 million)

*A real incident, told from the operator's own published account. The lessons section is our analysis and is labelled as such. Sources and what was not checked are at the end.*

## At a glance

**What happened.** A new trading feature was deployed to seven of eight servers. The eighth still contained old, retired code whose trigger flag had been repurposed. When market orders arrived, that server sent millions of unintended orders in 45 minutes, and the firm lost over $460 million.

**Key facts** (as published)
- 212 small retail orders turned into millions of child orders, over 4 million executions in 154 stocks and more than 397 million shares in about 45 minutes `[CONFIRMED]`.
- Net positions of about $3.5 billion long in 80 stocks and about $3.15 billion short in 74; the loss was over $460 million `[CONFIRMED]`.
- 97 automated e-mails with the error "Power Peg disabled" were sent before the market opened and were not acted upon `[CONFIRMED]`.

**Why it matters for architects.** The failure combines a manual, unreviewed deployment, dead code left in production, flag reuse, missing runtime controls and alerts that nobody read. It is the standard case for deployment verification and kill switches.

---

## What happened `[CONFIRMED]`

According to the SEC's order, Knight developed new code for its order router, SMARS, to support a retail liquidity program. The new code was meant to replace unused functionality called Power Peg that Knight had stopped using years earlier but that remained present and callable. The new code also repurposed a flag that had activated Power Peg. In 2005 a function that tracked cumulative shares had been moved, and Power Peg was not retested. Starting July 27, Knight deployed the new code in stages, a few servers per day. One technician did not copy the new code to one of eight servers; no second technician reviewed the deployment, and Knight had no written procedures that required such a review. On August 1, orders carrying the repurposed flag reached the eighth server, which ran the old Power Peg logic without the cumulative-quantity check, and it kept sending child orders for each parent order regardless of fills. Another part of Knight's order handling recognised that the parent orders had been filled, but that information was not communicated to SMARS. Controls were missing at the output: nothing compared orders leaving SMARS with those entering, nothing halted SMARS on its own aberrant behaviour, position limits for the account holding the stray positions did not link to firm-wide automated thresholds, and the e-mail messages that referenced the error were not designed as alerts.

## Contributing factors `[CONFIRMED]`

- Dead code left in the production system and a repurposed flag.
- A manual deployment to eight servers with no second reviewer and no written procedure requiring one.
- No verification that all servers ran the same version.
- No runtime controls on SMARS output, no automatic halt, and exposure limits not tied to automated order blocks.
- Warning e-mails were sent but were not treated as alerts.

## What the company changed `[CONFIRMED]`

- The SEC order concerns Knight's violation of the market-access rule (Rule 15c3-5), which requires risk controls and supervisory procedures; the order describes the missing controls rather than a list of fixes.

---

## 🔧 Our analysis (not from the source)

**Questions a design review could have asked**
- How do we prove every instance runs the same build before enabling a feature, and what blocks the flag from being turned on if not?
- Is any retired code still callable in production? Can a configuration value ever reach it?
- Do we reuse flags or fields for new meanings, and who reviews that?
- What compares the system's outputs with its inputs and stops it automatically when they diverge?
- What is the maximum exposure we allow automatically, and who can break that limit?
- Which alerts are really logs that nobody reads?

**Related notes:** [19 Stock exchange](../systems/19-stock-exchange.md) for ordering and risk checks; [C02 Cloudflare](C02-cloudflare-2019.md) for deployments without staging.

## Practice

Write the pre-deployment checklist, the runtime kill-switch conditions and the alert rules that would have limited this loss to minutes.

## Sources and provenance

> **Sources read on 2026-10-27:** U.S. Securities and Exchange Commission, [*In the Matter of Knight Capital Americas LLC*, Order, Release No. 34-70694](https://www.sec.gov/litigation/admin/2013/34-70694.pdf) (16 October 2013; PDF text read from an Internet Archive copy).
> **Dated material:** 2013 order about a 2012 event. The text is a regulatory finding of facts that Knight neither admitted nor denied; it reflects what the SEC established.
> **Not read:** Knight's own account and press coverage, and any later industry analyses.
> **Tags:** `[CONFIRMED]` stated by the primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Sections marked "Our analysis" are ours.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading the full text of the source. Quotations are confirmed by `npm run verify`.*
- Verified in the SEC order: the volumes, positions and loss, the deployment and server details, the repurposed flag, the missing review and procedures, the e-mail messages, and the missing controls.
- The SEC's findings were made in a settled proceeding; the facts are given as the SEC states them.
- Our analysis section is not sourced.
