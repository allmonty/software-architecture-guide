# P03 — Distributed transactions: 2PC, sagas and the outbox

*A primer on keeping data consistent across services and stores. Pattern descriptions come from Microsoft's Azure Architecture Center, the original sagas paper and the Kafka documentation; the decision guidance is our reasoning and is labelled.*

## At a glance

A transaction inside one database is atomic, consistent, isolated and durable (ACID). Once data lives in several services or stores, you cannot get those guarantees for free. The three common answers are **two-phase commit** (all participants prepare, then commit together), **sagas** (a sequence of local transactions with compensating steps) and the **transactional outbox** (write the event in the same local transaction as the data, publish it afterwards). Each trades isolation or latency for availability.

**In 60 seconds:** avoid distributed transactions by drawing service boundaries so one transaction covers one business invariant. Where you cannot, use a saga with idempotent steps and compensations, publish events with an outbox so a crash cannot lose them, and design consumers to be idempotent because delivery will repeat.

---

## 1. The problem `[CONFIRMED]` (Azure Architecture Center)

Microsoft's saga page explains that in a single service, transactions follow ACID because they run in one database, while microservices "typically assign a dedicated database to each microservice", so "traditional database guarantees like ACID aren't directly applicable to multiple independently managed data stores". It adds that architectures relying on inter-process communication or on the two-phase commit protocol "are often better suited for the Saga pattern".

## 2. Two-phase commit (2PC)

In 2PC a coordinator asks every participant to prepare, and commits only if all agree. It gives atomicity across stores but blocks participants while they wait on the coordinator, ties availability to the coordinator and every participant, and requires every store to support the protocol. The Kafka documentation gives a related practical point `[CONFIRMED]`: for writing consumer results to an external system, "the classic way of achieving this would be to introduce a two-phase commit between the storage of the consumer position and the storage of the consumers output", but this "can be handled more simply and generally by letting the consumer store its offset in the same place as its output", because many output systems "will not support a two-phase commit". (The blocking behaviour above is general knowledge of the protocol, not from these pages.) Kafka's own transactions, between Kafka topics, are a different mechanism; see [31 Ad click aggregation](../systems/31-ad-click-aggregation.md).

## 3. Sagas `[CONFIRMED]` (Garcia-Molina and Salem, 1987; Azure Architecture Center)

The original paper proposes splitting a long-lived transaction into a sequence of transactions that can interleave with other transactions, with the database guaranteeing that either all of them complete or compensating transactions run to amend a partial execution. Microsoft's description: the saga pattern "manages transactions by breaking them into a sequence of local transactions"; each completes atomically in one service, updates that service's database and starts the next step by event or message, and "if a local transaction fails, the saga performs a series of compensating transactions to reverse the changes that the preceding local transactions made."

**Step types** (Azure): *compensable* steps can be undone by a step with the opposite effect; pivot transactions "serve as the point of no return in the saga"; *retryable* steps follow the pivot and are idempotent so the saga can always reach its final state.

**Choreography versus orchestration** (Azure):
- *Choreography:* services exchange events with no central controller. Good for simple workflows with few services and no single point of failure; but the workflow is hard to follow as steps are added, cyclic dependencies are a risk, and integration testing is hard.
- *Orchestration:* a central orchestrator tells participants what to do, stores each step's state and handles failures with compensations. Better for complex workflows, avoids cyclic dependencies, separates responsibilities; but needs coordination logic and is a point of failure.

**What sagas do not give you** (Azure): there is no isolation across services, so data anomalies appear: lost updates, dirty reads and fuzzy (non-repeatable) reads. Countermeasures it lists: semantic locks, commutative updates, a pessimistic view (reorder steps so updates happen in retryable steps), and rereading values before updating. Also, "compensating transactions might not always succeed, which can leave the system in an inconsistent state"; participants commit their changes, so there is no rollback; and sagas are hard to debug and need monitoring.

Atlas examples: payments and holds in [16 Reservation scheduler](../systems/16-reservation-scheduler.md) and [17 Payment system](../systems/17-payment-system.md).

## 4. The transactional outbox `[CONFIRMED]` (Azure Architecture Center)

Problem: a service saves an order and then publishes an event; "this approach works until an error occurs between saving the order object and publishing the event", and a network error, a message-service outage or a host failure then loses the event, leaving other services inconsistent. Solution: save the event in an outbox table in the same database as the business data, "when you save the business object and its events within the same database transaction, the system guarantees no data loss", then a separate worker queries the outbox for unhandled entries, publishes them, and marks them processed. Practical complication from the page: you must preserve event order, for example publishing `OrderCreated` before `OrderUpdated`. The page's Cosmos DB version uses transactional batches, the change feed and Azure Service Bus, and ties the pattern to idempotent message processing.

**Delivery is at-least-once, so consumers must be idempotent** `[INDUSTRY PATTERN]`: a worker can publish an event and crash before marking it processed, so it will publish it again. Give each event a unique id and have consumers record the ids they have handled (see the Photon registry in note 31 and Stripe's idempotency keys in the API-design primer (P05)).

## 5. Choosing `[INDUSTRY PATTERN]`

| Situation | Reasonable choice |
|---|---|
| One invariant, one data owner | A single local transaction. Change the boundary rather than distribute. |
| Several services, long-running business process, tolerable intermediate states | Saga (orchestrated if more than a few steps) |
| A state change plus an event that must not be lost | Transactional outbox, idempotent consumers |
| Two stores that both support a transaction protocol and low latency, small number of participants | 2PC may be acceptable, with care |
| Money or irreversible actions | Saga with explicit pivot, ledger entries and reconciliation (see note 17) |

When asked in an interview, say which invariant you are protecting, what happens to users in the intermediate states, and how failures are compensated and monitored.

---

## Questions to practise

1. Why is two-phase commit a poor fit for many microservice systems?
2. Design a saga for booking a flight, a hotel and a car. Where is the pivot? What are the compensations?
3. What can go wrong between saving to a database and publishing an event, and how does the outbox fix it?
4. Choreography or orchestration for a six-step workflow? Why?
5. How do you stop a saga's dirty read from showing a customer the wrong state?

## Practice

Take the order flow in note 17 or the reservation flow in note 16 and mark each step as compensable, pivot or retryable. Write the compensation for every compensable step and the idempotency key for every retryable step.

**Related:** [16 Reservation scheduler](../systems/16-reservation-scheduler.md), [17 Payment system](../systems/17-payment-system.md), [31 Ad click aggregation](../systems/31-ad-click-aggregation.md), [04 Kafka](../systems/04-message-queue-kafka.md).

## Sources and provenance

> **Sources read on 2026-10-27:** Microsoft, [Saga design pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga) and [Transactional Outbox with Azure Cosmos DB](https://learn.microsoft.com/en-us/azure/architecture/databases/guide/transactional-outbox-cosmos) (Azure Architecture Center) · Garcia-Molina and Salem, [*Sagas*](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf) (SIGMOD 1987; the scanned PDF's text is noisy, so only the abstract's content is used and not quoted) · Apache Kafka [design documentation](https://raw.githubusercontent.com/apache/kafka/trunk/docs/design/design.md) (Message Delivery Semantics).
> **Dated material:** Microsoft pages as of 2026-10-27; the sagas paper is from 1987.
> **Not read:** The original two-phase commit literature, Spanner and other systems that provide distributed transactions, the Idempotent Consumer pattern page, and vendor-neutral outbox/CDC sources such as Debezium.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Azure pages: ACID definitions and the microservice database statement, saga steps and compensations, compensable, pivot and retryable definitions, choreography and orchestration trade-offs, the anomaly list and countermeasures, the outbox problem, solution and ordering complication.
- Verified in the Kafka document: the two-phase-commit and same-place-offset statements.
- Verified in the sagas paper (abstract, paraphrased).
- Not sourced (our reasoning): the 2PC blocking description, the idempotent-consumer requirement as stated, the choice table.
