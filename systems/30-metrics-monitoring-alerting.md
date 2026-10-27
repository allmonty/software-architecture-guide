# 30 — Metrics Monitoring and Alerting

*Real-system parts from Facebook's Gorilla paper (2015), Google's Monarch paper (2020) and the Prometheus documentation, plus a reference design that combines them. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A monitoring system collects numeric measurements (request counts, latencies, CPU) from many machines, stores them as time series, lets engineers query and graph them, and raises alerts when something is wrong. Its own design rule is unusual: it must be **more available than the things it watches**, so the published systems all **trade consistency and completeness for availability**: they accept dropping a little data rather than blocking. The other big ideas are **compressing time series** so recent data fits in memory, **cardinality control** (every new label combination is a new series), and **an alert pipeline** that evaluates rules, then groups, deduplicates and routes notifications.

**Key numbers** (as published, with the year)
- Gorilla (Facebook, 2015): more than 2 billion unique time series, about 12 million points per second, over 1 trillion points per day `[CONFIRMED]`.
- Gorilla compressed a 16-byte point to an average of 1.37 bytes, a 12 times reduction; about 96% of timestamps compress to a single bit `[CONFIRMED]`.
- Gorilla held the last 26 hours in memory because at least 85% of queries to its predecessor were for that window `[CONFIRMED]`. Query latency fell by 73 times and throughput rose 14 times against an HBase-backed store `[CONFIRMED]`.
- Monarch (Google, 2020) stores close to a petabyte of compressed data in memory, ingests terabytes per second and serves millions of queries per second `[CONFIRMED]`; up to 95% of its standing queries run entirely inside one zone `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Keep recent data in memory | Most queries are about the last day; speed and low dependency | RAM cost; history needs another store |
| Compress time series (delta-of-delta, XOR) | 12 times less memory | CPU cost, streaming-friendly design needed |
| Drop data rather than block writes | Monitoring must stay up when the rest is down | Small gaps in data |
| Evaluate alerts close to the data | Alerts keep working during partitions | Cross-region alerts are harder |
| Group, deduplicate and inhibit alerts | One outage should page once, not thousands of times | More configuration, risk of hiding a real alert |

**Common mistakes**
- Putting unbounded values (user IDs, request IDs) in labels. Each combination becomes a new series.
- Making the monitoring system depend on the systems it monitors (the circular dependency Monarch avoids).
- Alerting on every instance instead of the symptom, causing alert storms.
- Using a monitoring store for exact billing counts. Prometheus's documentation says it is not a good choice when you need 100% accuracy.

---

## 🧒 Non-technical explanation

Imagine a **hospital with a nurse station watching a thousand patients' heart monitors**. Every monitor sends a number every few seconds. The station keeps only the last day on screen because that is what people look at, and files older readings elsewhere. It would rather miss one beat on the chart than freeze the whole screen. When a number crosses a danger line for long enough, an alarm sounds; if fifty patients on one floor trip it at once because the power failed, the station sends **one** message "floor 3 has a power problem" instead of fifty phone calls.

---

## TL;DR for engineers

- **Data model:** a time series is identified by a metric name and labels; each new label combination is a new series `[CONFIRMED]` (Prometheus).
- **Collection:** pull (Prometheus scrapes over HTTP; push via a gateway for short-lived jobs) or push to ingestion routers (Monarch) `[CONFIRMED]`.
- **Storage:** in-memory recent data with compression plus a log and periodic blocks on disk `[CONFIRMED]` (Gorilla, Prometheus).
- **Availability over consistency:** drop delayed writes, return partial data, replicate to a second region without guaranteeing consistency `[CONFIRMED]`.
- **Alerting:** rules evaluated periodically (with a pending state before firing), then an alert manager groups, deduplicates, inhibits, silences and routes `[CONFIRMED]` (Prometheus).
- **Scale-out, retention tiers, multi-tenancy:** from Monarch and industry practice `[CONFIRMED]` / `[INDUSTRY PATTERN]` as marked.

---

## 1. Requirements (design framing)

**Functional:** ingest metrics from services · store as time series with labels · query and aggregate (rates, percentiles, sums by label) · dashboards · alert rules with notification routing · retention and rollups.

**Non-functional:** **availability** (higher than the monitored systems) · **write throughput** (millions of points per second) · **query latency** (tens of milliseconds to seconds) · **freshness** (alerts within seconds to a minute) · **cost** (memory) · **scalability in series count** · **disaster tolerance**.

**Clarifying questions:** how many series and how many points per second? What cardinality is expected, and who controls labels? Retention and resolution per tier? Alert latency target? Single or multi-region? Multi-tenant?

---

## 2. Data model and collection `[CONFIRMED]` (Prometheus documentation)

Prometheus "fundamentally stores all data as time series: streams of timestamped values belonging to the same metric and the same set of labeled dimensions". Each series is identified by its metric name and optional key-value labels; "the change of any label's value, including adding or removing labels, will create a new time series". The naming guidance is explicit: "Do not use labels to store dimensions with high cardinality (many different label values), such as user IDs, email addresses, or other unbounded sets of values".

**Architecture of the toolkit.** The Prometheus server scrapes metrics from instrumented jobs, "either directly or via an intermediary push gateway for short-lived jobs", stores samples locally and runs rules over them to record derived series or to generate alerts; an Alertmanager handles the alerts. Collection happens "via a pull model over HTTP", targets are found through service discovery or static configuration, and each server node is "autonomous": there is no reliance on distributed storage. The documentation presents this as a reliability feature: it is meant to be the system you go to during an outage.

**Where it does not fit.** For needs like per-request billing that require 100% accuracy, the documentation says Prometheus is not a good choice because collected data will likely not be detailed and complete enough.

**Local storage.** Samples are grouped into two-hour blocks, each with chunks, an index (mapping metric names and labels to series) and metadata. The current block is held in memory and protected by a **write-ahead log** replayed after a restart. Local storage is "not clustered or replicated", so it is not arbitrarily scalable or durable against node loss and should be managed like any single-node database; remote storage integrations exist.

---

### Push or pull?

The two published designs differ here, and each choice has reasons:
- **Pull (Prometheus):** the server scrapes targets over HTTP, discovering them through service discovery or static configuration, with a push gateway only for short-lived jobs `[CONFIRMED]`. Consequences (ours): the collector controls the rate and knows when a target is down (a failed scrape is itself a signal); targets need an HTTP endpoint reachable from the collector; short-lived jobs and firewalled networks fit badly.
- **Push (Monarch):** "a client sends data to one of the nearby ingestion routers", usually through an instrumentation library that writes at the frequency needed for the retention policy `[CONFIRMED]`. Consequences (ours): works through firewalls and for short-lived tasks; the client decides the rate, so the backend needs ingestion limits, and a silent target is harder to tell from a dead one without extra heartbeats.
- **Averaging percentiles is wrong.** Latency distributions should be stored as histograms or other mergeable summaries and combined before taking a percentile; the 99th percentile of per-instance 99ths is not the fleet's 99th percentile (our reasoning). Monarch's data model has first-class distribution-typed time series, and describes comprehensive support for them as a design goal `[CONFIRMED]`.

## 3. A hyperscale in-memory design: Gorilla `[CONFIRMED]` (Pelkonen et al., VLDB 2015)

**Requirements and insight.** Gorilla's authors argue that monitoring users care about **aggregate analysis**, not individual data points, and that recent data matters far more than old data. Their database optimises "for remaining highly available for writes and reads, even in the face of failures, at the expense of possibly dropping small amounts of data on the write path". Because the system stores no user data, ACID guarantees are not a core requirement. They also wanted state transitions (a bad release, a config change) visible within tens of seconds, and most queries to run within tens of milliseconds.

**Design.** Gorilla is an in-memory time series database that acts as a **write-through cache** of recent data in front of the persistent HBase store. From analysis of the older system, at least 85% of queries were for the past 26 hours, so Gorilla keeps 26 hours in memory. Each datum is a string key, a 64-bit timestamp and a double-precision value. Data is sharded by key across hosts in a share-nothing way; when launched, 26 hours fit into 1.3 TB of RAM on 20 machines, and the cluster later doubled twice to 80 machines.

**Compression.** Timestamps are stored as **delta-of-delta** (regular intervals compress to almost nothing; about 96% of timestamps become a single bit). Values are **XOR**ed with the previous value and the leading and trailing zeros encoded (about 51% of values are identical to the previous one and take a single bit). The average falls from 16 bytes to 1.37 bytes per point. The scheme works on a stream, point by point, which is why it suits an in-memory write path.

**Persistence.** Writes are appended to a per-shard log that is **not** a write-ahead log: data is buffered up to 64 kB, about one or two seconds, before flushing, so a crash can lose a little data; the authors judged the higher write availability worth it. Every two hours the compressed block is copied to disk, a checkpoint file marks it complete, and the logs are deleted.

**Failure handling.** Each time series is written to **two hosts in separate regions**, with no attempt to guarantee consistency between them. Reads go to the closest available instance and fail over to the other region when needed. A Paxos-based ShardManager reassigns shards when a node fails; during the move, write clients buffer one minute of data, dropping older points. If the rest of the cluster is healthy, shard movement completes in 30 seconds or less with no data loss. After a region-level failure, reads are turned off for that region until the cluster has been healthy for at least 26 hours.

**Result.** Compared with the HBase-backed store, query latency fell by 73 times and throughput rose 14 times, which "unlocked new monitoring and debugging tools" such as time series correlation search.

---

## 4. A planet-scale design: Monarch `[CONFIRMED]` (Adams et al., VLDB 2020)

**Principles.** Monarch "readily trades consistency for high availability and partition tolerance": reading from or writing to a strongly consistent database "may block for a long time", which would raise the time to detect and mitigate outages, so Monarch "drops delayed writes and returns partial data for queries if necessary", with mechanisms to indicate that data may be incomplete. It must also be **low dependency** on the alerting path: Google's storage systems rely on Monarch for monitoring, so Monarch stores data in memory and avoids using them, to avoid a circular dependency.

**Structure.** The organising principle is **local monitoring in regional zones with global management and querying**. Each zone is autonomous, made of clusters that are independent failure domains, and can keep working during outages of other zones or global components. Components: **leaves** (in-memory store), **recovery logs** (the same data on disk), a configuration server, **ingestion routers** and **leaf routers**, **range assigners** that balance data across leaves, **mixers** that split a query into sub-queries and merge results, **index servers** that limit fan-out, and **evaluators** that run standing queries.

**Queries.** Ad hoc queries come from users; **standing queries** are periodic materialized-view queries whose results are written back, used to condense data and to generate alerts. Global queries run through a three-level tree (root mixer, zone mixers, leaves), constrained by index servers. By static analysis most standing queries are evaluated by zone evaluators, up to 95% of standing queries are fully evaluated at zone level, which the authors say greatly increases tolerance to network partition and cuts latency.

**Scale.** In operation since 2010; close to a petabyte of compressed time series in memory; terabytes ingested per second; millions of queries per second; a schematized, relational data model.

---

## 5. The alert pipeline `[CONFIRMED]` (Prometheus documentation)

**Rules.** Alerting rules are expressions evaluated periodically; an element that satisfies the expression but has not yet held for the configured duration (the `for` clause) is in the **pending** state, and after that it is **firing**. An optional `keep_firing_for` keeps an alert firing for a period after the condition last held, to avoid flapping.

**Alertmanager.** It "takes care of deduplicating, grouping, and routing" alerts to receivers such as email, PagerDuty or OpsGenie, and handles silencing and inhibition:
- **Grouping:** many similar alerts become one notification. The documentation's example: a network partition makes hundreds of instances unable to reach the database; the operator wants a single page while still seeing which instances are affected, so alerts are grouped by cluster and alert name.
- **Inhibition:** suppress notifications for some alerts if certain other alerts are already firing (for example, mute everything about a cluster when a cluster-unreachable alert fires).
- **Silences:** mute alerts matching given matchers for a time.
- **High availability:** Alertmanager can run as a cluster. The documentation warns not to load-balance between Prometheus and its Alertmanagers; point Prometheus at the full list of them.

---

## 5b. Long-term storage and a global view: Thanos `[CONFIRMED]` (Thanos design documentation)

Prometheus's local storage is single-node (section 2). Thanos, an open-source set of components, is the documented way to add durable long-term storage and a cross-server query layer without changing the data model. Its design page says its goals are "operation simplicity and retaining of Prometheus's reliability properties".
- **Sources:** a **sidecar** next to each Prometheus server exposes its data over a gRPC Store API, and **rule nodes** evaluate rules; both advertise what data they hold.
- **Backup to object storage:** the Prometheus storage engine periodically produces **immutable blocks** for a fixed time range (a directory with chunk files, an index and a `meta.json`); sidecars upload them to an object storage bucket as they are created, adding external labels to the metadata so blocks can later be filtered "without accessing their data files".
- **Store nodes:** a gateway to the blocks in the bucket that implements the same Store API, synchronises which blocks exist, filters relevant blocks by time range and labels, and caches index lookups. Because sample data for a series is laid out sequentially, a request is translated into a minimal number of object-storage reads, each fetching up to hundreds of thousands of chunks. Chunk data is not cached because, as the design page puts it, fetching it "already only accounts for a small fraction of end-to-end latency".
- **Queriers:** stateless, horizontally scalable instances that implement PromQL on top of the Store APIs, minimising fan-out using each node's metadata.
- **Compactor:** a singleton that merges small blocks into larger ones, reducing storage size and the number of requests per query, and also performs **downsampling and retention**.
- **Scaling:** "none of the Thanos components provides any means of sharding"; only queriers are explicitly scalable, with capacity scaling through the external object store.

This is a different answer to the same problem Gorilla and Monarch solve. Gorilla and Monarch keep the hot window in distributed memory with built-in replication and regions; Thanos keeps Prometheus's simple single-server collectors and adds a bucket for history and a query tier for a global view, trading query-time speed for simplicity. It fits the retention-tier bullet in section 6, and its downsampling and retention live in the compactor.

## 6. Reference design `[INDUSTRY PATTERN]` (combining the above)

```
services/exporters ─(scrape or push)─► collectors ─► sharded TSDB (in-memory recent data + log + blocks)
                                           │                  │ replicate to second region
                                           ▼                  ▼
                                    shard manager      long-term store (rollups)
rule evaluators ─ query ─► TSDB ─ firing alerts ─► alert manager ─► notification channels ─► on-call
dashboards/query API ─────► TSDB (closest healthy replica)
```

- **Collection tier:** stateless collectors scrape or receive metrics, enforce label rules and limits, and route each series to its shard by hashing its identity.
- **Series limits:** cap series per tenant and per metric; reject or drop series that exceed limits, and alert the owner. Cardinality explosions are the most common way a monitoring system falls over.
- **Retention tiers:** raw data for hours or days in memory or on fast disk, downsampled rollups (for example 5-minute averages) for months or years in cheaper storage. Rollups lose detail such as peaks; keep max and percentile sketches where needed.
- **Alert evaluation near the data:** as in Monarch, run rules in the same region as the data so a partition does not silence them.
- **Meta-monitoring:** monitor the monitor with an independent, simpler system and a "dead man's switch" alert that fires if alerts stop arriving.
- **Alert quality:** alert on symptoms users feel (error rate, latency) rather than every cause; every alert needs an owner and a runbook.
- **Multi-tenancy:** per-tenant quotas, isolation of heavy queries, and access control.

---

## 7. Failure scenarios

- **A collector or ingest shard fails.** Writes are buffered briefly and shards reassigned, with older points dropped rather than blocking `[CONFIRMED]` (Gorilla).
- **A region is lost.** Reads fail over to the other region's copy `[CONFIRMED]` (Gorilla); Monarch zones keep working independently `[CONFIRMED]`.
- **A network partition.** Zone-local rule evaluation keeps alerts working `[CONFIRMED]` (Monarch).
- **Cardinality explosion.** A bad label creates millions of series and exhausts memory; per-tenant limits and rejection protect the rest `[INDUSTRY PATTERN]`; the cause is documented in `[CONFIRMED]` Prometheus guidance.
- **Alert storm.** Grouping and inhibition reduce pages `[CONFIRMED]`.
- **The monitoring system itself is down.** Independent meta-monitoring and a dead man's switch `[INDUSTRY PATTERN]`.
- **Crash loses recent data.** Accepted: Gorilla's log can lose one or two seconds, while Prometheus's WAL protects the in-memory block `[CONFIRMED]`.

---

## 8. Capacity reasoning (illustrative)

- **Memory ≈ active series × bytes per point × points retained.** Gorilla's published figures: 12 million points per second is about 1 trillion per day; at 16 bytes per point that is 16 TB, versus roughly 1.4 TB at 1.37 bytes. Their paper says 16 TB of RAM was impractical, motivating compression.
- **A back-of-envelope for your own system:** 1 million series scraped every 15 seconds is about 67,000 points per second (1,000,000 ÷ 15), or about 5.8 billion points per day. At 1.37 bytes per point (Gorilla's average, which will differ on your data) that is about 8 GB per day of compressed data. These are our assumptions and arithmetic.
- **Collector throughput** scales with series count divided by scrape interval; shards scale with total memory.

---

## ⚠️ Reviewer notes

1. **Three different systems.** Gorilla (2015, Facebook), Monarch (2020, Google) and Prometheus (open source) make different choices. In particular Prometheus is single-node by design, while the others are planet-scale distributed systems; do not mix their guarantees.
2. **The figures are dated.** Gorilla's numbers are Spring 2015; Monarch's are from the 2020 paper. Both companies' systems have certainly changed.
3. **Prometheus documentation is version-specific and evolving** (for example UTF-8 names arrived in v3.0). We read the pages as of 2026-10-27.
4. **Alert design guidance (symptom alerts, runbooks, dead man's switch) is industry practice,** not from these sources.
5. **Not read:** Facebook's later Beringei or Scuba papers, Cortex or Mimir designs (Thanos is covered from its design page, section 5b), VictoriaMetrics, OpenTelemetry, logging and tracing systems, and anomaly detection.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **availability** (above its customers), **performance** (ingest and query), **scalability**, **cost efficiency**, **data currency**.
- **Style (Ch 13):** a **pipeline** (collect, store, evaluate, notify) on a **share-nothing sharded** store, with regional autonomy.
- **Quanta (Ch 7):** each zone or region is its own quantum so a failure elsewhere does not stop local alerting.
- **Trade-off (First Law, Ch 1):** **consistency/completeness vs availability.** The published systems choose availability and accept gaps.
- **ADR sketch (Ch 19):** *"We will keep recent data in memory with replicated regional copies, evaluate alerts in the same region as the data, and drop delayed writes rather than block. We accept occasional small data gaps in exchange for monitoring that stays up during incidents."*
- Plain English: keep today's chart on the wall, never freeze the screen, and page once per fire.

---

## Interview questions to practice

1. Design a metrics monitoring and alerting system for thousands of services.
2. How do you store time series efficiently? How does compression work?
3. Push or pull collection? Trade-offs?
4. What is cardinality, and how do you protect against explosions?
5. Should a monitoring database be consistent or available? Why?
6. How do you design the alerting pipeline to avoid alert storms and missed alerts?
7. How do you keep years of history affordably?
8. How do you monitor the monitoring system?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: series count, points per second, retention, alert latency, regions, tenants.
2. Estimate: points per day, bytes per point, memory for the hot window, storage for rollups.
3. API: write (push or scrape), query language, alert rule definition.
4. Design: collectors, sharded TSDB with log and blocks, replication across regions, rule evaluators, alert manager, long-term store.
5. Deep dive: compression, sharding and shard reassignment, cardinality limits, rollups.
6. Failure and scale: node and region failure, partition, alert storm, monitor-the-monitor.

**If it grows 10×**
- Memory: stronger compression, shorter hot window, tiered storage.
- Series count: enforce limits, pre-aggregate at collectors, shard the index.
- Alert load: zone-local evaluation, standing queries that pre-aggregate.

**Answer outlines** (try the questions above first)

<details><summary>Push or pull?</summary>

Pull gives the collector control of the rate and a built-in liveness signal, but needs reachable endpoints and handles short-lived jobs poorly (a push gateway covers them). Push suits firewalls, ephemeral tasks and very large fleets with regional ingestion routers, but needs ingestion limits and separate liveness checks. Large systems often mix both; say which failure you are optimising for.

</details>

<details><summary>Consistency or availability for a monitoring database?</summary>

Availability. If the database blocks during an outage, engineers lose the view they need most, and alerts are delayed. Drop delayed writes, serve partial data with an indicator, and replicate to a second region without strict consistency. Do not use it where exact counts are required, such as billing.

</details>

<details><summary>How do you stop a cardinality explosion?</summary>

Review and restrict label names and values at instrumentation time, never put unbounded values in labels, enforce per-tenant series limits at the collectors, drop or reject excess series, and alert the owner with the offending metric.

</details>

<details><summary>How do you avoid alert storms?</summary>

Alert on symptoms, group related alerts into one notification, inhibit lower-level alerts when a higher-level one fires, add a pending duration to avoid flapping, and route to the owning team with a runbook link.

</details>

## 📚 Further reading

- The papers and documentation listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [03 Distributed key-value store](03-distributed-kv-store.md) for sharding and replication, [04 Kafka](04-message-queue-kafka.md) for buffering ingest, [10 Notification system](10-notification-system.md) for delivering alerts, [02 Rate limiter](02-rate-limiter.md) for per-tenant limits.

## Sources and provenance

> **Kind:** reference design with real parts. Gorilla and Monarch describe real production systems at Facebook and Google; Prometheus is an open-source toolkit with public documentation. The combined design in section 6 is ours `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Pelkonen et al., [*Gorilla: A Fast, Scalable, In-Memory Time Series Database*](https://www.vldb.org/pvldb/vol8/p1816-teller.pdf) (VLDB 2015) · Adams et al., [*Monarch: Google's Planet-Scale In-Memory Time Series Database*](https://www.vldb.org/pvldb/vol13/p3181-adams.pdf) (VLDB 2020) · Prometheus documentation: [Overview](https://prometheus.io/docs/introduction/overview/), [Data model](https://prometheus.io/docs/concepts/data_model/), [Storage](https://prometheus.io/docs/prometheus/latest/storage/), [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/), [Alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) and [Metric and label naming](https://prometheus.io/docs/practices/naming/) · Thanos [design documentation](https://thanos.io/tip/thanos/design.md/). PDF text extracted locally.
> **Dated material:** Gorilla figures are from Spring 2015; Monarch from 2020; Prometheus documentation as of this date.
> **Not read:** Cortex, Mimir, VictoriaMetrics, OpenTelemetry, Facebook's follow-up work, tracing and logging systems.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source in full. Quotations are confirmed by `npm run verify`.*
- Verified in the Gorilla paper: abstract claims (10 times, 73 times, 14 times), requirements, 85% of queries within 26 hours, Spring 2015 scale (2 billion series, 12 million points per second, over 1 trillion per day), 16 bytes to 1.37 bytes (12 times), 1.3 TB on 20 machines growing to 80 machines, delta-of-delta (96% of timestamps to one bit) and XOR (51% of values to one bit), log that is not a write-ahead log (64 kB buffer), two-hour blocks with checkpoint file, two regions without consistency, ShardManager (Paxos-based), one-minute write buffers, thirty-second shard movement, 26-hour region recovery rule.
- Verified in the Monarch paper: abstract and scale claims, consistency-for-availability principle, circular-dependency argument, zonal autonomy, component list, standing queries and the 95% zone-level figure, three-level query tree.
- Verified in the Prometheus documentation: data model and label rule, cardinality warning, architecture and components, pull model and push gateway, autonomy and non-fit statement, two-hour blocks and WAL, non-clustered storage limitation, pending and firing states and `keep_firing_for`, Alertmanager grouping, inhibition, silences and high-availability guidance.
- Verified in the Thanos design page: sidecar and rule sources, immutable blocks uploaded to object storage with external labels, store nodes filtering by metadata and caching only index data, stateless queriers, the compactor's merging, downsampling and retention, and the no-sharding scaling statement.
- Labelled industry pattern, not sourced: the combined reference design, series limits, retention tiers, meta-monitoring, alert-quality advice, capacity arithmetic.
- Not claimed: how any specific current monitoring product works.
