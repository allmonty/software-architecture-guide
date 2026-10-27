# C02 — Cloudflare outage, 2 July 2019 (regex backtracking)

*A real incident, told from the operator's own published account. The lessons section is our analysis and is labelled as such. Sources and what was not checked are at the end.*

## At a glance

**What happened.** A new WAF rule contained a regular expression that backtracked enormously. Rules are deployed globally in seconds, the test suite had no CPU check, and a protection against runaway regexes had been removed in a refactoring. CPUs serving HTTP traffic hit nearly 100% worldwide for 27 minutes and customers saw 502 errors.

**Key facts** (as published)
- Deployed at 13:42 UTC; first page at 13:45; the WAF was identified at 14:00; global WAF termination executed at 14:07; traffic and CPU normal by 14:09; WAF re-enabled globally at 14:52 `[CONFIRMED]`.
- The outage lasted 27 minutes; WAF rule changes had averaged one every 3 hours over 60 days (476 change requests) `[CONFIRMED]`.
- Quicksilver distributes about 350 changes per second with a p99 of 2.29 s to every machine worldwide `[CONFIRMED]`.

**Why it matters for architects.** Fast global deployment and safe deployment pull in opposite directions. The incident shows a process (staged rollout) that existed for code but not for this class of change.

---

## What happened `[CONFIRMED]`

An engineer on the firewall team deployed a minor change to XSS detection rules through an automatic process. The change passed code review and CI, and went out through Quicksilver, Cloudflare's own distributed key-value store, which can push changes globally in seconds. The Lua WAF used PCRE, which uses backtracking for matching and has no mechanism to protect against a runaway expression. The result was that CPUs handling HTTP and HTTPS traffic were exhausted worldwide and the front-line servers returned 502 errors. Alerts fired within three minutes, SRE declared a P0, and an attack was ruled out once the Performance Team showed live CPU data pointing at the WAF. The team then used a global terminate to disable the WAF worldwide, but reaching it was slow: Cloudflare's own Access service was down so staff could not authenticate to the internal control panel, some had lost access because credentials expire when unused, and Jira and the build system also needed a rarely used bypass.

## Contributing factors `[CONFIRMED]`

- An engineer wrote a regular expression that could backtrack enormously.
- A protection against excessive CPU use by a regular expression had been removed by mistake during a refactoring weeks earlier.
- The regular expression engine did not have complexity guarantees.
- The test suite had no way to identify excessive CPU consumption.
- The standard operating procedure allowed a non-emergency rule change to go globally into production without a staged rollout (software releases go through a dogfooding PoP, a small share of free-customer traffic and three canary PoPs first).
- The rollback plan required running the complete WAF build twice, which took too long.
- The first alert for the global traffic drop took too long to fire, the status page was not updated quickly enough, and customers could not reach the dashboard or API because they pass through the same edge.

## What the company changed `[CONFIRMED]`

- Stopped all WAF release work; restored the CPU protection; inspected all 3,868 managed rules for similar backtracking.
- Added performance profiling of every rule to the test suite.
- Moving to the re2 or Rust regex engines, which have run-time guarantees.
- Changing the procedure to staged rollouts for rules, while keeping an emergency global path for active attacks.
- Adding an emergency way to take the dashboard and API off Cloudflare's edge, and automating status page updates.

---

## 🔧 Our analysis (not from the source)

**Questions a design review could have asked**
- Which of our change types bypass the staged-rollout path because they need to be fast, and what is the blast radius if one is wrong?
- Do our tests measure resource use (CPU, memory, latency), or only correctness?
- Does our regex or parsing engine give complexity guarantees on untrusted or machine-written input?
- Can our responders reach the control plane when our own product is down?
- Is there a one-step, tested kill switch for every globally deployed component?

**Related notes:** [02 Rate limiter](../systems/02-rate-limiter.md) and [13 Netflix](../systems/13-netflix.md) for control planes and staged rollouts; [C05 Knight Capital](C05-knight-capital-2012.md) for another unstaged deployment.

## Practice

Design a staged rollout for rules that must reach every edge in under a minute during an attack. What is canaried, what is the abort signal, and when may you skip a stage?

## Sources and provenance

> **Sources read on 2026-10-27:** Cloudflare, [*Details of the Cloudflare outage on July 2, 2019*](https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/).
> **Dated material:** 2019. Cloudflare says it has since changed its WAF engine and rollout process; this note describes the post as published.
> **Not read:** Cloudflare's later incident reports and the regex backtracking appendix beyond the points above.
> **Tags:** `[CONFIRMED]` stated by the primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Sections marked "Our analysis" are ours.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading the full text of the source. Quotations are confirmed by `npm run verify`.*
- Verified in the Cloudflare post: the timeline, the 27-minute duration, the rule and deployment path, the list of contributing factors, the access problems during response, the change list, and the Quicksilver figures.
- Our analysis section is not sourced.
