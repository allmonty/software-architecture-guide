# W04 — Decision exercises

*Six architecture scenarios that ask for a decision and its justification, the part of an architect's job that system-design cases rarely practise.*

## How to use this page

These are open scenarios with no single correct answer. For each, write a one-page ADR or design-doc section (template in [P09](P09-decisions-and-design-docs.md)), then compare it with the list of points a strong answer covers. A good answer states assumptions, compares real options, names what it gives up, and says what would change the decision.

## 1. Messaging between services

**Context.** Twelve internal services must exchange events: order created, payment settled, inventory changed. Volume is about 2,000 events per second, with spikes to 20,000. Some consumers need to replay history after a bug fix. The team has three engineers who have run a queue before.

**Task.** Choose the messaging approach and write the ADR (context, options, decision, consequences).

<details><summary>What a strong answer covers</summary>

- Distinguishes a queue (consume and delete) from a log (retain and replay) and ties the replay requirement to the choice ([04 Kafka](../systems/04-message-queue-kafka.md)).
- Addresses ordering scope (per key), delivery semantics and idempotent consumers ([P03](P03-distributed-transactions.md)).
- Considers operations and team skill (a managed service versus running brokers) and cost ([P08](P08-cost-as-a-design-input.md)).
- Names consequences: schema evolution, consumer lag monitoring, dead-letter handling.

**A typical weak answer:** Picks a technology by name without a requirement, or ignores replay.

</details>

## 2. Should we split the monolith?

**Context.** A 10-year-old monolith with 60 engineers deploys weekly; releases are slow because of coordination and a shared database. Leadership proposes moving to microservices within a year.

**Task.** Argue for or against, and propose what you would do first.

<details><summary>What a strong answer covers</summary>

- Starts from the problem (deployment coupling, team contention) and the driving characteristics, not the style ([book summaries 17 and 18](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/18-choosing-architecture-style.md), [17 Microservices](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/17-microservices-architecture.md)).
- Considers intermediate options: a modular monolith, service-based architecture, extracting one high-churn capability.
- Proposes an incremental path with a seam, a façade and data ownership ([P10](P10-changing-systems-safely.md)).
- Names costs: distributed transactions ([P03](P03-distributed-transactions.md)), operations, observability, team structure (Conway's law).

**A typical weak answer:** Treats microservices as the goal or dismisses them without evidence.

</details>

## 3. Surviving a region failure

**Context.** An e-commerce platform runs in one region with a primary database and replicas. After an outage the business wants to survive the loss of a region with at most 5 minutes of data loss and 30 minutes of downtime.

**Task.** Design the multi-region approach and state what you give up.

<details><summary>What a strong answer covers</summary>

- Turns the targets into RPO 5 minutes and RTO 30 minutes and tests each option against them.
- Compares active-passive with asynchronous replication, active-active with conflict handling, and partitioned ownership; names the consistency trade-offs ([03 Key-value store](../systems/03-distributed-kv-store.md)).
- Plans failover: who decides, automation limits, application latency, reconciliation of unreplicated writes ([C03 GitHub 2018](C03-github-2018.md)).
- Includes rehearsals, cost ([P08](P08-cost-as-a-design-input.md)) and dependencies such as DNS and identity ([C04 Facebook 2021](C04-facebook-2021.md)).

**A typical weak answer:** Says 'use multi-region' without recovery targets, failover decision or data reconciliation.

</details>

## 4. Build or buy semantic search

**Context.** A product team wants semantic search over 5 million support articles within a quarter. Options: a managed vector database, a Postgres extension, or building on an open-source ANN library.

**Task.** Recommend an option and state the revisit trigger.

<details><summary>What a strong answer covers</summary>

- Estimates scale (vectors, dimensions, memory) and query rate ([P01](P01-estimation.md), [24 Vector search](../systems/24-vector-semantic-search.md)).
- Considers filtering, freshness, hybrid keyword search and evaluation of retrieval quality ([23 RAG](../systems/23-rag-knowledge-assistant.md)).
- Weighs total cost including people, lock-in, data governance ([P08](P08-cost-as-a-design-input.md)); uses the boring-technology argument where it applies ([P09](P09-decisions-and-design-docs.md)).
- Defines when to change: scale, latency or recall thresholds.

**A typical weak answer:** Chooses on brand familiarity, or builds without justifying the maintenance cost.

</details>

## 5. SLOs for checkout

**Context.** A checkout service depends on an inventory service, a payment provider and a tax service. The business says it must be 'always up'.

**Task.** Propose SLIs, SLOs, an error-budget policy and the architecture changes the targets require.

<details><summary>What a strong answer covers</summary>

- Defines user-centred SLIs (successful checkouts, latency percentile) and explains why 100% is the wrong target ([P07](P07-slos-and-incidents.md)).
- Computes the combined availability of the dependency chain and shows which dependencies need fallbacks or asynchronous paths.
- States an error-budget policy: what happens when the budget is spent.
- Adds protection against cascades: timeouts, bounded retries, load shedding, degraded modes.

**A typical weak answer:** Promises 99.99% without looking at dependencies or cost.

</details>

## 6. An AI feature in the product

**Context.** The product team wants an assistant that answers customers' questions about their own account and can take actions such as cancelling an order.

**Task.** Decide between prompting, retrieval, fine-tuning and an agent for each part, and list the safety and evaluation requirements.

<details><summary>What a strong answer covers</summary>

- Uses the simplest approach that works for each need: retrieval for account facts ([23 RAG](../systems/23-rag-knowledge-assistant.md)), a constrained workflow or agent for actions ([25 AI agent platform](../systems/25-ai-agent-platform.md)), fine-tuning only for behaviour or format ([28 Fine-tuning](../systems/28-llm-finetuning-evaluation.md)).
- Puts permissions outside the model, approvals on irreversible actions, and treats retrieved text as untrusted ([P06](P06-security-threat-modeling.md)).
- Defines evaluation before launch: retrieval recall, answer groundedness, action success, safety, and a regression suite.
- Estimates cost per conversation and sets budgets and limits ([P08](P08-cost-as-a-design-input.md)).

**A typical weak answer:** Gives the model direct access to the account database, or skips evaluation.

</details>



**Related:** [P09 Decisions and design docs](P09-decisions-and-design-docs.md), [P10 Changing systems safely](P10-changing-systems-safely.md), the book summaries on [architecture decisions](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/19-architecture-decisions.md) and [choosing an architecture style](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/18-choosing-architecture-style.md).

## Sources and provenance

> **Kind:** practice material. The exercises, answer keys and rubrics are **our reasoning** `[INDUSTRY PATTERN]`. Where a fact is sourced it is linked to the atlas note or primer that cites the primary source.
> **Sources:** Exercises and rubrics are our own. Facts they rely on are sourced in the linked atlas notes and primers; each exercise links its evidence.
> **Not read:** Published interview-rubric research and company-specific hiring rubrics.

---
## ✅ Verification log

*Checked 2026-10-27.*
- The lists of points are our judgement of what a review would look for; they cite the notes and primers where the supporting facts are sourced.
- Links checked by `npm run validate`.
