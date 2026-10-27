# P12 — Event sourcing and CQRS: storing changes, splitting reads from writes

*A primer on two patterns that are often used together and often misused. The definitions and warnings come from Martin Fowler's articles on Event Sourcing (2005) and CQRS (2011), Microsoft's Azure Architecture Center pages on both patterns, and Greg Young's CQRS documents; the decision method is our reasoning and is labelled. The consistent message of the sources: both patterns have real uses, and both are overused.*

## At a glance

**Event sourcing** stores every change to an entity as an immutable **event** in an append-only log, and treats that log, not a row of current values, as the source of truth. The current state is derived by replaying events. **CQRS** (command query responsibility segregation) uses a different model to update information than the one used to read it. They are independent ideas: CQRS does not need event sourcing, and an event-sourced system still has to answer queries somehow, which usually means building read models, which is where CQRS comes in. What you gain is history, replay and models tuned to each side. What you pay for is eventual consistency, event schema evolution, a harder time querying and testing, and a steep learning curve. Fowler's verdict on CQRS is that "for most systems CQRS adds risky complexity".

**In 60 seconds:** if you need a trustworthy history of *why* state changed, to rebuild or correct state by replay, or independent scaling of heavy reads, one of these may earn its cost. Apply them to one bounded part of a system, not the whole. If you only need an audit trail or a reporting view, a simpler tool (an audit table, change-data-capture with an outbox, a reporting database) does that for far less.

---

## 1. Event sourcing `[CONFIRMED]` (Fowler, 2005; Azure Architecture Center)

Fowler's definition: "Event Sourcing ensures that all changes to application state are stored as a sequence of events." The key rule is that "we guarantee that all changes to the domain objects are initiated by the event objects". From the event log you get facilities a state table cannot give: a **complete rebuild** ("We can discard the application state completely and rebuild it by re-running the events from the event log on an empty application."), **temporal queries** ("We can determine the application state at any point in time."), and **event replay** to correct a past event and recompute its consequences. Version control systems are his everyday example.

The Azure page describes the mechanics. Each entity has its own **eventstream**, "Each event is recorded in an append-only store", and the store "serves as the system of record". "Applications derive the current state of an entity by replaying all the events in its stream. This process is known as rehydration." Because replay is costly, systems keep **materialized views**, read-only projections of the event store built for querying, and **snapshots**, but "Snapshots are an optimization, not a replacement for the eventstream." Events are named for what happened in business terms (for example `OrderCanceled`), which is how they capture intent. The same page contrasts the pattern with CRUD's two weak spots in high-load systems: write contention from read-modify-write cycles, and lost history when only the latest state is stored.

An event store is not just a message broker. The Azure page warns: "Don't confuse an event store with an eventstream message broker." A broker such as Kafka distributes events well but typically lacks per-entity stream reads and optimistic concurrency, so it usually serves as the distribution layer beside a store (see [04 Kafka](../systems/04-message-queue-kafka.md) for what a log gives you).

## 2. CQRS `[CONFIRMED]` (Fowler, 2011; Azure Architecture Center)

Fowler: "At its heart is the notion that you can use a different model to update information than the model you use to read information." The two models can be separate object models, run in different processes, and use the same or separate databases; if separate, some mechanism must carry changes from the command side to the query side, and "eventual consistency" follows. The Azure page frames the problems it addresses: the read and write representations differ, parallel operations cause lock contention, and security is hard to manage when one entity serves both. Its advice on commands is to make them "specific business tasks instead of low-level data updates" (book a room, rather than set a status field).

Both sources say where it fits, and both are cautious.

- Fowler: the benefit is mostly in two places, some complex domains and high-performance applications ("CQRS allows you to separate the load from reads and writes allowing you to scale each independently."). But "such suitability for CQRS is very much the minority case", "CQRS is a significant mental leap for all concerned, so shouldn't be tackled unless the benefit is worth the jump", and it "should only be used on specific portions of a system", not all of it. If the domain does not suit it but you have demanding queries, he points to a **reporting database** for those queries only.
- Azure: use it where users edit the same data concurrently, with task-based interfaces, or high read-to-write ratios; skip it when "The domain or the business rules are simple." It also notes the complexity "specifically when combined with the Event Sourcing pattern."

## 3. Together, and why they pair `[CONFIRMED]` (Young; Fowler)

Event sourcing alone cannot answer arbitrary queries from the log. Greg Young's CQRS documents say so plainly: "One of the largest issues when using Event Sourcing is that you cannot ask the system a query such as" a search by name, because there is no representation of current state. CQRS supplies the answer: the write side stores events, and the read side builds query models from them. Fowler says CQRS "fits well with event-based programming models" and lets services use event sourcing. Our reading `[INDUSTRY PATTERN]`: treat them as separate decisions. You can have CQRS over a plain relational write model, and event sourcing whose only read model is "get by id".

## 4. Costs and failure modes `[CONFIRMED]` (Azure Architecture Center), with our commentary

The Azure page lists the issues to plan for; each is a failure mode a design review should ask about:

- **Eventual consistency.** "Eventual consistency between the event store and projections is inherent to event sourcing." A user can read stale data right after a write; design the interface and the cache for that (see [P03](P03-distributed-transactions.md) on living with it).
- **Event schema evolution.** Events are immutable, so the schema must change without rewriting them. The page names versioning each event and **upcasting**: "Register transformation functions that convert older event schemas to the current schema during deserialization."
- **Duplicates and ordering.** Delivery is typically at least once, so "Event handlers must be idempotent so processing a duplicate event doesn't change the outcome." Otherwise projections drift and side effects such as payments or notifications fire twice. The idempotency and outbox patterns are in [P03](P03-distributed-transactions.md).
- **Concurrent writers.** Optimistic concurrency rejects an append if the stream changed since it was read; the handler reloads and retries. Conflicts that span several entities still need application logic.
- **Personal data.** "The append-only, immutable nature of an event store conflicts with data protection regulations that require deletion of personal data". The page suggests keeping personal data outside the store and referencing it by identifier, or encrypting it per subject and deleting the key ("crypto-shredding"), at the price of key management and extra work on every read and write.
- **Skills and operations.** It changes how you test, debug and operate a system; the page lists teams without event-driven experience as a reason not to use it.

In the atlas, [19 Stock exchange](../systems/19-stock-exchange.md) describes a matching engine whose state is rebuilt from its input events, with snapshots to speed restarts, as an event-sourced design chosen for deterministic replay. Compare how [17 Payments](../systems/17-payment-system.md) gets correctness from idempotency instead.

## 5. A way to decide `[INDUSTRY PATTERN]`

Our reasoning, not a source's rule. Start from what you need, and pick the lightest tool that gives it.

| You need | Lightest sufficient tool |
|---|---|
| An audit trail of changes | An audit table or change log written in the same transaction |
| Heavy or odd queries without touching the main model | A reporting database or read replica (Fowler's alternative to CQRS) |
| Reliable events to other services | The outbox pattern ([P03](P03-distributed-transactions.md)) |
| Different shapes or scaling for reads and writes in one bounded context | CQRS, still over a normal write store |
| History *as* the source of truth, replay and temporal queries, correction of past events | Event sourcing, in that one bounded context, with a plan for versioning, snapshots, projections and personal data |
| A simple CRUD domain | Neither |

---

## Questions to practise

1. What is the source of truth in an event-sourced system, and how is current state obtained?
2. What do snapshots do, and why can they not replace the event stream?
3. Why can event sourcing alone not answer a search for all users with a given name? What does CQRS add?
4. Name three failure modes of event sourcing and the mitigation for each.
5. A product team wants an audit log. Do you recommend event sourcing? What would change your answer?
6. How do you delete a user's personal data from an immutable log?
7. Explain why an event store is not the same thing as a message broker.

## Practice

Take the checkout flow of [17 Payments](../systems/17-payment-system.md) and sketch it twice: once as a CRUD table with an audit log, once as an event-sourced order stream with two projections (customer order history, finance reconciliation). List the events, the read models and, for each projection, what is stale for how long. Then say which version you would build for a team of five and why.

---

## Sources and provenance

> **Sources read on 2026-10-27:** Martin Fowler, [*Event Sourcing*](https://martinfowler.com/eaaDev/EventSourcing.html) (12 December 2005) and [*CQRS*](https://martinfowler.com/bliki/CQRS.html) (14 July 2011) · Microsoft Azure Architecture Center, [*Event Sourcing pattern*](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) and [*CQRS pattern*](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs) (the pages show "Last updated" dates of 2026-03-28 for Event Sourcing and 2025-02-21 for CQRS) · Greg Young, [*CQRS Documents*](https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf) (PDF hosted since 2010; text extracted locally).
> **Dated material:** Fowler's definitions are from 2005 and 2011 and Young's document is from around 2010; the patterns are stable but the products and cloud services the Azure pages mention change. Microsoft revises these pages over time.
> **Not read:** event store products' documentation, Kafka-based event sourcing in production, Axon or other frameworks, case studies of failed adoptions (Fowler's remark that most CQRS cases he saw "have not been so good" is his anecdote, not measured), and Young's talks.
> **Tags:** `[CONFIRMED]` stated by a primary source we read · `[INDUSTRY PATTERN]` standard practice or our reading of the sources · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in Fowler's Event Sourcing article: the definition, the rule that events initiate all changes, and the rebuild and temporal-query facilities.
- Verified in Fowler's CQRS article: the core idea, the variations in how the models are separated, the two places he sees benefits, and his warnings (minority case, mental leap, bounded context only, reporting database as the alternative).
- Verified in the Azure Event Sourcing page: the append-only eventstream and system-of-record wording, rehydration, materialized views, snapshots as an optimization, the event store versus broker warning, upcasting, idempotent handlers, optimistic concurrency, personal-data conflict and its two mitigations, and the "not suitable when" list.
- Verified in the Azure CQRS page: the problems it addresses, the business-task wording for commands, when it fits and when it does not, and the complexity warning with event sourcing.
- Verified in Young's document: the sentence about querying an event-sourced system.
- Not claimed: how any product implements these patterns; that either pattern is right for a particular system; measured benefits or failure rates.
- Our reasoning, not from the sources: the section 3 reading that the two are separate decisions, the commentary after each Azure item, the pointers to atlas notes, and the table in section 5.
