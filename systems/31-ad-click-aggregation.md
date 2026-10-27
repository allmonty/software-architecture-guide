# 31 — Ad Click Aggregation and Stream Analytics

*Real-system parts from Google's Photon paper (2013), the Dataflow Model paper (2015), and the Apache Flink and Kafka documentation, plus a reference design for the aggregation pipeline. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Advertisers are billed per click, so the pipeline that counts clicks must be **correct** (never charge twice, never lose a billable click) and also **fast** (dashboards within seconds). The difficulty is that events arrive late, out of order and more than once, and machines and whole datacenters fail. The proven building blocks are: **deduplicate by a unique event id** kept in a fault-tolerant store (Photon), **group events by event time in windows with watermarks** that decide when a window is complete enough (Dataflow model), **checkpoint operator state together with source positions** so a restart replays without double counting (Flink), and **transactional or idempotent writes** between stages (Kafka). A slower reconciliation path then corrects the fast one, so the answer is *near-exact* in real time and *exactly right eventually*.

**Key numbers** (as published, with the year)
- Photon (Google, 2013): processes millions of events per minute at peak with an average end-to-end latency under 10 seconds `[CONFIRMED]`.
- Its requirement: join 99.9999% of events within a few seconds and 100% within a few hours, with output used for billing advertisers `[CONFIRMED]`.
- Observed losses were below 0.0001 percent of joinable events in normal conditions `[CONFIRMED]`; a retry token cut missing clicks by two orders of magnitude `[CONFIRMED]`.
- Its deduplication state kept event ids for a bounded number of days (3 in the deployment described) `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Unique id per event, checked in a replicated registry | No click is counted twice, even across datacenters | A cross-region commit (up to 100 ms) per batch; storage for ids |
| Event-time windows with watermarks | Correct counts despite late and out-of-order events | Waiting for stragglers adds latency; late data still needs a policy |
| Checkpoint state with source offsets | Exactly-once effect after failures | Checkpoint overhead, and sources must be replayable |
| Fast path plus reconciliation | Fast dashboards and correct billing | Two results to explain; extra pipeline to run |
| Bounded dedup window (N days) | Storage stays finite | Events delayed more than N days must be dropped or handled separately |

**Common mistakes**
- Counting clicks on arrival time. Late and retried events then land in the wrong minute.
- Claiming "exactly once" without saying where: delivery, processing or the effect on the output.
- Deduplicating in memory only, so a restart double counts.
- No reconciliation path for the rare losses that any non-atomic design has.
- Windowing without deciding what to do with data that arrives after the window closed.

---

## 🧒 Non-technical explanation

Imagine a **toll booth that bills drivers per trip**, with photos arriving from many cameras, sometimes twice, sometimes an hour late. Each photo has a **serial number**; before billing, the clerk checks a **ledger** and refuses a serial that is already there. For the daily totals the clerk groups photos by the time the **car passed**, not the time the photo arrived, and closes a day's page only when they're fairly sure no more photos for that day are coming. Every so often the clerk bookmarks the page and the ledger together, so after a spill they can reopen from the bookmark without counting anything twice. At night an auditor compares everything and fixes small differences.

---

## TL;DR for engineers

- **Dedup:** assign every event a unique id and register ids in a strongly consistent store; at-most-once at the output, at-least-once at the input, eventually exactly-once `[CONFIRMED]` (Photon).
- **Time:** aggregate by **event time**; watermarks declare that no more events older than t should arrive, and are usually a heuristic; late data needs a policy `[CONFIRMED]` (Dataflow, Flink).
- **Failure:** checkpoints cover operator state and source positions; sources must be replayable `[CONFIRMED]` (Flink).
- **Between stages:** idempotent producers and transactions that commit offsets with output `[CONFIRMED]` (Kafka).
- **Serving and reconciliation:** an aggregate store for queries and a slower batch path to correct it `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** ingest click (and impression) events · count clicks per ad per time window (for example per minute) · filter fraud and duplicates · serve aggregates to dashboards · produce billing totals.

**Non-functional:** **correctness** for billing (no double or lost charges) · **latency** (dashboards in seconds) · **throughput** (very high peak click rates) · **fault tolerance** (machine and datacenter loss) · **late data** tolerance · **auditability** and replay.

**Clarifying questions:** event volume and peak? Window sizes and latency target? Is the number used for billing? How late can events be? Do clicks need joining with impressions or queries? Which dimensions (ad, campaign, country)? How long must raw events be kept?

---

## 2. Deduplicated, exactly-once-in-effect joining: Photon `[CONFIRMED]` (Ananthanarayanan et al., SIGMOD 2013)

**Problem.** Google's advertising system logs a search **query** event and, if the user clicks an ad, a **click** event that references the query's id. Photon joins each click with its query in real time. The paper states: "Photon must guarantee that a single click is never processed twice, since this leads to double-charging the advertisers", while "Google loses money for every click which is not processed". Hence the requirement of **at-most-once at any point in time, near-exact in real time, and exactly-once eventually**.

**Datacenter fault tolerance.** The same pipeline runs independently in at least two datacenters. Workers in several datacenters may try to join the same click, so they coordinate through shared state: the set of click ids already joined in the last N days, kept in the **IdRegistry**.

**IdRegistry.** A fault-tolerant, geographically replicated store built on a Paxos-based key-value store (PaxosDB), with replicas in different regions so a region outage does not stop it. A Paxos commit can take up to 100 milliseconds because of round-trip latency, so throughput comes from **server-side batching** (many ids per commit) and **sharding** the id space across servers. Old ids are garbage-collected after N days (3 in the paper's deployment); a request for an event older than the boundary timestamp gets a special error and the event is skipped.

**Pipeline in one datacenter.** A **dispatcher** reads clicks from the logs and checks the IdRegistry; if the click id is present, it was already joined and is skipped. Otherwise it sends the click to a stateless **joiner** and retries with backoff if the join fails, giving at-least-once input. The joiner looks up the query in the **EventStore** (an in-memory cache of recent queries backed by a log-based lookup), then tries to register the click id in the IdRegistry. If registration succeeds it writes the joined click to the output log; if the id is already registered it drops the event as a "wasted join".

**Closing the atomicity gap.** Registering the id and writing the output are not one transaction. If the joiner registers the id but its RPC times out, a retry would be refused and the click would never be joined. Photon sends a **globally unique token** with each registration; the registry stores it and treats a retry with the same token as success. This reduced missing clicks in the joined logs by two orders of magnitude. A crash between registering and writing can still lose a click. A **verification system** scans inputs against outputs; for a click present in the registry but absent in the output, whose joiner has crashed or restarted, it deletes the id and re-injects the event. In normal conditions observed losses were below 0.0001 percent.

**Results.** Millions of events per minute at peak with average end-to-end latency under 10 seconds, with the pipeline tolerating infrastructure degradation and datacenter-level outages without manual intervention.

---

## 3. Time, windows and late data: the Dataflow Model `[CONFIRMED]` (Akidau et al., VLDB 2015)

The paper argues that for unbounded, unordered data we must "stop trying to groom unbounded datasets into finite pools of information that eventually become complete" and instead assume that "we will never know if or when we have seen all of our data". It frames every streaming computation by four questions: **what** results are computed, **where in event time** they are computed (windowing), **when in processing time** they are materialised (triggers and watermarks), and how later refinements relate to earlier results. It states that one can never fully optimise "correctness, latency, and cost" at the same time.

**Watermarks.** A watermark is a notion of progress in event time. The paper explains that in many real systems it is impossible to have enough knowledge to establish a 100% correct watermark, so most watermarks are heuristics; data that arrives behind the watermark is **late** and needs handling through triggers (for example firing again with an updated result).

**Flink's description of the same ideas.** Event time is "the time that each individual event occurred on its producing device"; processing time is the machine's clock. A `Watermark(t)` "declares that event time has reached time t in that stream, meaning that there should be no more elements from the stream with a timestamp t' <= t". Because only a finite wait is possible, "this places a limit on how deterministic event time applications can be".

---

## 4. Surviving failures: checkpoints and transactions `[CONFIRMED]`

**Flink checkpoints.** Flink "continuously draws snapshots of the distributed streaming data flow". A checkpoint marks a specific point in each input stream together with the corresponding state of each operator; after a failure the job restores the operators' state and replays the records from that point, which gives **exactly-once processing semantics** for the state. This requires that the source can rewind (Kafka can). **Barriers** are injected at the sources, flow with the records and never overtake them; an operator that has received the barrier for snapshot n from all its inputs emits its own barrier and snapshots its state, so snapshots happen without stopping the stream. The documentation describes the checkpoint interval as trading off fault-tolerance overhead against recovery time (how many records must be replayed), and notes that exactly-once is preferable for most applications while at-least-once may suit super-low-latency ones.

**Kafka delivery semantics.** Kafka's documentation distinguishes at-most-once, at-least-once and exactly-once, and warns that many systems claim "exactly-once" in ways that are misleading, for example when consumers or producers can fail. Since version 0.11 an **idempotent producer** (a producer ID plus a sequence number per message) ensures that resending does not duplicate entries in the log, and **transactions** let a producer write atomically to multiple partitions. For consume-process-produce, the consumer's offset is stored in Kafka and written in the **same transaction** as the output, so on abort both revert; consumers using `read_committed` isolation see only committed transactions. For an external system, the documentation recommends storing the consumer's offset in the same place as the output rather than a two-phase commit, because many output systems cannot do one.

---

**Which sinks give end-to-end exactly-once (Flink documentation).** Exactly-once state updates alone are not enough: "to guarantee end-to-end exactly-once record delivery (in addition to exactly-once state semantics), the data sink needs to take part in the checkpointing mechanism". The bundled-sink table lists, for example, the Kafka producer as at least once or exactly once ("exactly once with transactional producers (v 0.11+)"), the Cassandra sink as exactly once only for idempotent updates, and Elasticsearch, DynamoDB and Redis sinks as at least once. For sources, Kafka is exactly once because it can rewind, while Google Pub/Sub is listed as at least once. The practical reading: choose a sink that is transactional or make writes idempotent, as this note's aggregate store does.

---

## 4b. The aggregate store for ads data: Mesa `[CONFIRMED]` (Gupta et al., VLDB 2014)

Photon produces clean joined clicks; Mesa is Google's published answer for storing and querying the aggregates. The paper describes "a highly scalable analytic data warehousing system that stores critical measurement data related to Google's Internet advertising business", handling petabytes, millions of row updates per second, and billions of queries fetching trillions of rows per day, geo-replicated and returning consistent, repeatable query answers even when an entire datacenter fails. Its main ideas:
- **Atomic, versioned batch updates.** Updates arrive in batches produced by an upstream system "typically at a frequency of every few minutes" (smaller batches mean lower latency but more resource use). Each update has a version number assigned sequentially; Mesa applies updates strictly in version order and incorporates each entirely before the next, so "users can never see any effects from a partially incorporated update". Queries name a version and see a consistent view.
- **Aggregation by key with associative functions.** Tables have key and value columns with a schema-defined aggregation function (such as SUM) that must be associative; each update holds at most one aggregated value per key.
- **Deltas.** To avoid storing every version or aggregating every version at query time, Mesa pre-aggregates versions into **deltas** covering version ranges [V1, V2], incorporating each update as a singleton delta and merging deltas in the background (compaction).
- **Corrections as negative facts.** Strict ordering lets an incorrect fact be offset by an inverse action: fraudulent clicks identified by online fraud detection are offset by negative clicks and costs in a later version, and the strict ordering guarantees that a negative fact can never be incorporated before its positive counterpart.
- **Consistency across datacenters** uses a Paxos-based protocol for metadata and update commits.

Contrast with this note's reference design: Mesa gets idempotency and correctness from **versioned, ordered, additive batches and negative corrections**, where our aggregate store upserts by (ad, window). Both achieve the property that applying the same input twice does not double count, by different means; the Mesa approach also keeps an audit trail of corrections, which matters for billing.

---

## 5. Reference design for ad click aggregation `[INDUSTRY PATTERN]`

```
ad server / browser ─► click collector (assign unique click id, validate) ─► click log (partitioned, replayable)
                                                                                │
                       dedup + join (Photon-style registry) ◄───────────────────┘
                                                                                │ valid, unique clicks
                       stream aggregator: event-time windows · watermark · checkpointed state
                                                                                │
                       aggregate store (by ad, minute) ─► dashboards, billing feed
                                      ▲
         raw log in object storage ─► batch reconciliation (recompute, compare, correct)
```

- **Collection:** clicks pass through a redirect or tracking endpoint that assigns a unique id, validates the signature of the ad request, and writes to a partitioned, replayable log. Keep the raw log, because replaying it is the recovery path.
- **Partitioning:** partition by ad id (or click id for dedup) so related events meet in the same worker; handle hot ads with sub-partitioning and a final merge.
- **Aggregation:** tumbling event-time windows (for example one minute) per ad, with a watermark and an allowed lateness; updated results are emitted when late data arrives within the lateness, and later data goes to a **late-data stream** for batch correction.
- **Storage for queries:** an OLAP or time-series store keyed by ad and window, upserting by (ad, window) so a re-emitted window replaces the old value rather than adding to it, which makes writes idempotent.
- **Reconciliation:** a batch job recomputes totals from the raw log (periodically or nightly), compares with the stream results and corrects them; billing uses the reconciled figures. This is often called a Lambda-style design; a design that uses only the replayable log and the stream engine is called Kappa-style. Which to use depends on how much you trust replay and how different the batch and stream logic are.
- **Fraud and quality:** filter bots and invalid clicks before billing, with rules and models; keep the filtering rules versioned so reprocessing is reproducible. Mesa shows a documented alternative for clicks found invalid after the fact: write negative facts that offset them (section 4b).
- **Observability:** watch input lag, watermark delay, checkpoint duration, dedup hit rate and the stream-versus-batch difference.

---

## 6. Failure scenarios

- **A worker crashes.** The job restores from the last checkpoint and replays from the saved source offsets; state and offsets are consistent `[CONFIRMED]` (Flink).
- **A producer retries a write.** The idempotent producer or a unique id prevents duplicates `[CONFIRMED]` (Kafka, Photon).
- **A joiner registers an id and then crashes.** One click can be lost; verification finds it and re-injects the event `[CONFIRMED]` (Photon).
- **A datacenter outage.** The other datacenter's pipeline continues, and the failed one catches up from its backlog, mostly skipping events already in the registry `[CONFIRMED]` (Photon).
- **Late events beyond the lateness.** Send to the late-data stream and correct in reconciliation `[INDUSTRY PATTERN]`; the existence of late data and heuristic watermarks is `[CONFIRMED]` (Dataflow).
- **Hot ad creates skew.** Sub-partition by click id and merge; monitor per-partition lag `[INDUSTRY PATTERN]`.
- **Stream and batch totals disagree.** Investigate lost or duplicated events; billing waits for the reconciled number `[INDUSTRY PATTERN]`.

---

## 7. Capacity reasoning (illustrative)

- **Event rate:** 1 billion clicks per day is about 11,600 clicks per second on average (1,000,000,000 ÷ 86,400); a peak several times higher is plausible, so size for tens of thousands per second. These are our assumptions.
- **Dedup storage:** ids × bytes × retention. 1 billion clicks per day with 16-byte ids kept for 3 days is about 48 GB of raw id bytes before index and replication overhead.
- **Raw log:** 1 billion clicks × 500 bytes ≈ 500 GB per day before compression; keep long enough to replay and reconcile.
- **Aggregate rows:** (ads × windows). 1 million active ads × 1,440 minutes ≈ 1.4 billion rows per day if every ad has a click every minute; most do not, so use sparse storage.

---

## ⚠️ Reviewer notes

1. **Photon is from 2013 and describes Google's ads join.** Google's current systems have certainly changed; the design principles (unique ids, replicated registry, retry tokens, verification) remain instructive.
2. **"Exactly-once" means different things.** Photon's guarantee is at-most-once always and exactly-once eventually; Flink's is exactly-once for state under replay; Kafka's transactions give exactly-once between Kafka topics. None gives exactly-once to an arbitrary external side effect without idempotent or transactional output.
3. **The Lambda and Kappa labels are industry terms,** not from the sources we read, and the Dataflow paper's arguments about unified models are not summarised here beyond the four questions.
4. **Kafka documentation was read from the Apache Kafka source repository's design document** because the website page requires scripts; it reflects the trunk branch at that time.
5. **Not read:** Flink's Kafka sink two-phase-commit implementation details, fraud detection research, and ad-tech specifications. Mesa is covered from the paper only; we did not read later papers on Google's ads data infrastructure.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **data integrity** (billing), **fault tolerance**, **performance** (latency), **scalability**, **auditability**.
- **Style (Ch 13):** an **event-driven pipeline** with a replayable log as the system of record, plus a batch correction path.
- **Quanta (Ch 7):** ingestion, dedup/join, aggregation, serving and reconciliation are separate quanta, joined by the log.
- **Trade-off (First Law, Ch 1):** **latency vs correctness.** Waiting for late events and reconciling makes numbers right and slower; showing near-real-time numbers now makes them provisional.
- **ADR sketch (Ch 19):** *"We will count by event time with watermarks, deduplicate by a unique click id in a replicated registry, and correct provisional totals with a batch reconciliation before billing. We accept two paths to maintain in exchange for fast dashboards and exact invoices."*
- Plain English: a ledger that refuses repeats, a bookmark that survives spills, and an auditor at night.

---

## Interview questions to practice

1. Design a system that aggregates ad clicks per ad per minute and is used for billing.
2. How do you make sure a click is counted exactly once?
3. What happens when events arrive late or out of order?
4. How do you recover after a stream processor crashes?
5. What does "exactly-once" actually guarantee in Kafka and Flink?
6. How do you handle a hot ad with millions of clicks?
7. How do you verify the stream results are right?
8. How would you store and query the aggregates?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: volume, windows, latency, billing use, lateness, dimensions.
2. Estimate: events per second, dedup storage, raw log size, aggregate rows.
3. API: click endpoint (with unique id), aggregate query endpoint.
4. Design: collector, replayable log, dedup registry, stream aggregator with windows and checkpoints, aggregate store, batch reconciliation.
5. Deep dive: exactly-once in effect (ids, idempotent writes, checkpoints), watermarks and late data.
6. Failure and scale: worker crash, datacenter loss, hot keys, late data, disagreement between paths.

**If it grows 10×**
- Partitions and workers scale out; hot keys need sub-partitioning.
- The dedup registry shards and batches commits; shorten the id retention to what lateness allows.
- Reconciliation moves to incremental recomputation of recent windows.

**Answer outlines** (try the questions above first)

<details><summary>How do you count each click exactly once?</summary>

Give every click a unique id at collection. Deduplicate against a replicated registry that refuses an id it has already seen; write aggregates idempotently by (ad, window); checkpoint state together with source offsets so a replay does not double count. Then reconcile against the raw log, because the steps are not one atomic transaction.

</details>

<details><summary>What do you do with late events?</summary>

Window by event time with a watermark and an allowed lateness. Within the lateness, re-emit the corrected window; after it, send the event to a late stream that the batch reconciliation folds in. Decide the lateness from measured delay distributions, and expose provisional versus final status to consumers.

</details>

<details><summary>What does "exactly-once" mean in Kafka and Flink?</summary>

Kafka: an idempotent producer prevents duplicate log entries on retry, and transactions commit output and consumer offsets atomically between Kafka topics. Flink: after a failure state is restored from a checkpoint and records replayed, so state is as if each record were processed once. Effects on external systems still need idempotent or transactional sinks.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [04 Message queue (Kafka)](04-message-queue-kafka.md), [17 Payment system](17-payment-system.md) for idempotency and reconciliation, [19 Stock exchange](19-stock-exchange.md) for ordering and replay, [30 Metrics monitoring and alerting](30-metrics-monitoring-alerting.md) for time series storage.

## Sources and provenance

> **Kind:** reference design with real parts. Photon describes a real production system at Google; the Dataflow Model, Flink and Kafka documents describe published models and systems. The end-to-end click aggregation pipeline in section 5 is the standard design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (PDF text extracted locally):** Ananthanarayanan et al., [*Photon: Fault-tolerant and Scalable Joining of Continuous Data Streams*](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/41318.pdf) (SIGMOD 2013) · Akidau et al., [*The Dataflow Model*](https://www.vldb.org/pvldb/vol8/p1792-Akidau.pdf) (VLDB 2015) · Apache Flink documentation: [Stateful Stream Processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/stateful-stream-processing/), [Timely Stream Processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/) and [Checkpointing](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/fault-tolerance/checkpointing/) · Gupta et al., [*Mesa: Geo-Replicated, Near Real-Time, Scalable Data Warehousing*](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/42851.pdf) (VLDB 2014) · Apache Flink [Fault Tolerance Guarantees of Data Sources and Sinks](https://nightlies.apache.org/flink/flink-docs-stable/docs/connectors/datastream/guarantees/) · Apache Kafka [design documentation](https://raw.githubusercontent.com/apache/kafka/trunk/docs/design/design.md) (Message Delivery Semantics).
> **Dated material:** Photon 2013, Dataflow 2015; Flink and Kafka documentation as of this date.
> **Not read:** Flink's Kafka sink two-phase-commit implementation, fraud-detection literature, ad-tech standards.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the Photon paper: abstract claims (at-most-once, near-exact, eventually exactly-once; millions of events per minute; average latency under 10 seconds), the 99.9999% and 100% requirement, the double-charging statement, multi-datacenter pipelines, IdRegistry on PaxosDB with replicas in different regions, 100 ms commits, server-side batching and sharding, N-day garbage collection (3 days in the deployment), dispatcher and joiner steps, token retry mechanism (two orders of magnitude), crash window, verification and recovery, below 0.0001 percent losses.
- Verified in the Dataflow Model paper: the quoted claims about unbounded data, the four questions, the tension among correctness, latency and cost, heuristic watermarks.
- Verified in the Flink documentation: checkpoint and replay description, source rewindability, barrier behaviour, checkpoint interval trade-off, exactly-once versus at-least-once guidance, event time, processing time and `Watermark(t)` definition.
- Verified in the Kafka design document: the three semantics, the misleading-claims warning, idempotent producer (version 0.11), transactions, offset committed with output, `read_committed`, the external-system recommendation.
- Verified in the Mesa paper: the abstract's scale and consistency claims, batched versioned updates every few minutes, strict version ordering and atomic incorporation, associative aggregation functions, deltas and singletons, negative facts for fraud corrections.
- Verified in the Flink guarantees page: the end-to-end exactly-once requirement for sinks and the source and sink table entries cited.
- Labelled industry pattern, not sourced: the click collector, partitioning, aggregate store, upsert by window, reconciliation, Lambda and Kappa labels, fraud filtering, observability and capacity arithmetic.
- Not claimed: how any current ad platform counts clicks.
