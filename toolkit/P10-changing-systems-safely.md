# P10 — Changing systems safely: strangler fig and branch by abstraction

*A primer on migrating and replacing parts of a running system. The patterns are described from Martin Fowler's articles and Microsoft's Azure Architecture Center; the migration checklist is our reasoning and is labelled.*

## At a glance

Most architecture work is not greenfield. The question is how to replace a database, a framework or a whole legacy system without a big-bang rewrite. Two patterns cover most cases: the **strangler fig**, which routes traffic through a façade while pieces of functionality move to a new system one at a time, and **branch by abstraction**, which hides the thing being replaced behind an interface so old and new implementations can coexist inside one codebase while you keep releasing.

**In 60 seconds:** put a façade in front, migrate by slices of value, keep both systems running until each slice is proven, make rollback cheap at every step, and decommission the old piece only when nothing depends on it.

---

## 1. Strangler fig `[CONFIRMED]` (Fowler, 2024; Azure Architecture Center)

Fowler describes the name's origin: strangler figs germinate in a tree, grow around it, and can leave the vine standing as an echo of the tree's shape once the host dies; he uses the image for the gradual replacement of legacy software, as opposed to a rewrite. Microsoft's pattern page defines it as: "incrementally migrate a legacy system by gradually replacing specific pieces of functionality with new applications and services", so that the new system eventually comprises all the old features and the old one can be decommissioned.

**The problem it addresses** (Azure): it is difficult to replace an entire complex system at once; running parallel versions forces clients to track which version has each feature. **The solution:** after identifying new service boundaries, use an incremental process in which "customers continue to use the same interface and are unaware that a migration is in progress". The page's four phases: a façade routes client requests between legacy and new systems; incremental decomposition shifts more requests to the new system; the legacy system is fully decommissioned; and the façade can eventually be removed.

## 2. Branch by abstraction `[CONFIRMED]` (Fowler, 2014)

A technique "for making a large-scale change to a software system in gradual way that allows you to release the system regularly while the change is still in-progress". Steps from the article: create an abstraction layer that captures the interaction between client code and the current supplier; move all client code to use the abstraction; build a new supplier behind the same abstraction; switch clients over gradually (using feature flags to run the new supplier in test environments and compare behaviour with the old one); and delete the old supplier when it is no longer needed. Along the way the work improves test coverage of the old supplier through the abstraction.

## 3. A migration checklist `[INDUSTRY PATTERN]`

| Step | Questions |
|---|---|
| Choose the seam | Where is a stable boundary (an API, a module, a table owner)? Migrating by capability is easier than by layer. |
| Build the façade or abstraction | Can it route by feature, user cohort or percentage? Does it add latency or become a new single point of failure? |
| Handle data | Which system owns each piece of data during the move? Use dual writes only with a reconciliation plan, or change-data-capture from the old store, and plan the cutover of reads and writes separately. |
| Prove equivalence | Shadow traffic and result comparison before cutover; metrics on both sides (see [P07](P07-slos-and-incidents.md)). |
| Cut over gradually | Percentage rollouts with a fast rollback, as [C02 Cloudflare 2019](C02-cloudflare-2019.md) and [C05 Knight Capital](C05-knight-capital-2012.md) show when rollouts are not staged or verified. |
| Retire the old | Remove dead code and flags; Knight's loss involved retired code that remained callable. |
| Protect the team | Keep the old system's maintainers until the end; communicate the plan and the rollback (see the book summaries on teams and negotiation: [22 Making teams effective](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/22-making-teams-effective.md)). |

**Atlas examples:** the staged adoption of a new datastore at scale appears in the Discord and Dropbox notes ([09 Discord](../systems/09-discord.md), [06 File sync](../systems/06-file-sync-dropbox.md)); the failover and restore lessons in [C03 GitHub 2018](C03-github-2018.md) apply to any data migration.

**Anti-patterns to name:** the big-bang rewrite, migrating without a rollback, two systems that both own the same data with no reconciliation, and a façade that accumulates business logic.

---

## Questions to practise

1. Why is an incremental replacement usually safer than a rewrite?
2. Walk through migrating a monolith's billing module to a service with a strangler fig. What does the façade do?
3. How does branch by abstraction let you keep releasing during a large change?
4. How do you migrate data between two datastores without downtime?
5. What would make you stop a migration halfway?

## Practice

Plan the migration of one atlas system's storage layer (for example moving the URL shortener from a relational database to a key-value store). Write the seam, the façade, the data ownership during the move, the equivalence checks, the rollout stages and the rollback.

**Related:** [P09 Decisions and design docs](P09-decisions-and-design-docs.md), [C02 Cloudflare 2019](C02-cloudflare-2019.md), [C03 GitHub 2018](C03-github-2018.md), [C05 Knight Capital](C05-knight-capital-2012.md), [01 URL shortener](../systems/01-url-shortener.md).

## Sources and provenance

> **Sources read on 2026-10-27:** Martin Fowler, [*Strangler Fig*](https://martinfowler.com/bliki/StranglerFigApplication.html) (22 August 2024) and [*Branch By Abstraction*](https://martinfowler.com/bliki/BranchByAbstraction.html) (7 January 2014) · Microsoft, [Strangler Fig pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig) (Azure Architecture Center).
> **Dated material:** Fowler's pieces are essays; Microsoft's page changes over time. Read 2026-10-27.
> **Not read:** The Azure anti-corruption layer pattern (fetched but not used), books and talks on legacy modernization, and data-migration tooling such as change-data-capture frameworks.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in Fowler's Strangler Fig article: the origin metaphor and its use for gradual modernization.
- Verified in the Azure page: the definition, the problem statement, the solution and the four phases.
- Verified in the Branch By Abstraction article: the definition and the steps.
- Not sourced (our reasoning): the checklist, the anti-patterns and the practice exercise.
