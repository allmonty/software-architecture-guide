# C03 — GitHub outage, 21 October 2018 (failover and split-brain writes)

*A real incident, told from the operator's own published account. The lessons section is our analysis and is labelled as such. Sources and what was not checked are at the end.*

## At a glance

**What happened.** A 43-second network partition made GitHub's automated MySQL failover promote primaries in another region. When connectivity returned, both sides held writes the other lacked, so failing back safely was impossible. GitHub chose to preserve data and accept 24 hours and 11 minutes of degraded service.

**Key facts** (as published)
- Partition at 22:52 UTC on 21 October after routine optical-equipment maintenance; connectivity was back in 43 seconds `[CONFIRMED]`.
- Total degradation: 24 hours and 11 minutes; no user data was lost, though reconciliation of a few seconds of writes continued `[CONFIRMED]`.
- One of the busiest clusters had 954 writes in the affected window that had not replicated to the other site `[CONFIRMED]`.

**Why it matters for architects.** (Our reading.) Automated failover, backups and the application's tolerance for latency each looked reasonable on its own; together they produced a topology the application could not live with and a recovery that took a day.

---

## What happened `[CONFIRMED]`

GitHub runs MySQL clusters with functional sharding and uses Orchestrator, built on Raft, to manage topology and automate failover. During the partition, the Orchestrator nodes on the West Coast and in the East Coast public cloud formed a quorum and failed clusters over so writes went to the West Coast. When connectivity returned, the application tier began writing to the new primaries. The East Coast databases held a brief period of writes not replicated westward, so neither side could simply take over. East Coast applications could not cope with cross-country latency on most database calls, so using the West Coast primaries made the site unusable for many users. GitHub made the explicit choice to prioritize data integrity over site usability and time to recovery: it paused webhook delivery and Pages builds, restored from backups, and rebuilt replication. Backups were stored in remote public cloud blob storage, and downloading, decompressing, checksumming and loading multiple terabytes took hours. The restore procedure was tested daily, but GitHub had never needed to rebuild an entire cluster from backup before. Status estimates based on replication progress were later acknowledged as inaccurate.

## Contributing factors `[CONFIRMED]`

- Orchestrator behaved as configured, but the application tier could not support cross-region primaries; the partition was larger than any seen before.
- Unreplicated writes existed on both sides after the failover.
- GitHub had previously been able to rely on strategies such as delayed replicas, but until this incident it had never needed to fully rebuild an entire cluster from backup, which is what recovery required.
- The status page offered only green, yellow and red.

## What the company changed `[CONFIRMED]`

- Configure Orchestrator to prevent promotion of primaries across regional boundaries.
- Accelerate a new status mechanism that shows the state of individual components.
- Continue the project to serve traffic from multiple data centers in an active/active/active design for N+1 facility redundancy.
- Invest in fault injection and chaos engineering, and test assumptions more actively.

---

## 🔧 Our analysis (not from the source)

**Questions a design review could have asked**
- When automation fails over, what invariant must hold (for example, no cross-region primary), and where is that invariant encoded?
- If two sides both accept writes during a partition, how do we reconcile them, and what do we sacrifice (availability or consistency) in which cases?
- What is the real time to rebuild each datastore from backup, and have we measured it at current size?
- Which application paths cannot tolerate added latency, and does the failover design know about them?

**Related notes:** [03 Distributed key-value store](../systems/03-distributed-kv-store.md) for quorums and reconciliation; [16 Reservation scheduler](../systems/16-reservation-scheduler.md) for correctness under contention.

## Practice

Write the decision record GitHub's team faced at 23:13 UTC: options (fail forward, restore, accept data loss), criteria, and what you would have chosen.

## Sources and provenance

> **Sources read on 2026-10-27:** GitHub, [*October 21 post-incident analysis*](https://github.blog/news-insights/company-news/oct21-post-incident-analysis/) (30 October 2018).
> **Dated material:** 2018. GitHub's architecture has changed since.
> **Not read:** GitHub's earlier posts on MySQL high availability and Orchestrator, and later reliability reports.
> **Tags:** `[CONFIRMED]` stated by the primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Sections marked "Our analysis" are ours.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading the full text of the source. This page has no quotations, so `npm run verify` had nothing to check.*
- Verified in the GitHub post: the maintenance trigger, the 43-second partition, the Orchestrator failover behaviour, the data-integrity decision, backup restore constraints, the 954-write example, and the technical and organisational follow-ups.
- Our analysis section is not sourced.
