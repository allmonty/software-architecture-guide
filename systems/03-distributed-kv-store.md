# 03 — Distributed Key-Value Store (Dynamo-style)

*A documented real system. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Dynamo is an always-writeable key-value store. It places keys on a consistent-hash ring with virtual nodes, replicates each key to N nodes, and lets you tune R and W. Writes survive failures through a sloppy quorum and hinted handoff, conflicts are detected with vector clocks and reconciled on read, and replicas converge through read repair and Merkle-tree anti-entropy.

**Key numbers**
- Common (N,R,W) = (3,2,2) `[CONFIRMED]`.
- 99.9th-percentile SLA example: 300 ms at 500 requests/s `[CONFIRMED]`.
- 99.9995% successful responses over the first two years, with no data-loss event `[CONFIRMED]` (authors' own report).

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Sloppy quorum + hinted handoff | Writes succeed during failures | Weaker guarantees: a 'quorum' may include stand-ins |
| Vector clocks, client reconciliation | No silent lost updates | The application must merge versions |
| Zero-hop routing | No multi-hop latency variance | Every node must hold the ring map |

**Common mistakes**
- Saying 'DynamoDB' and then describing the 2007 paper's vector clocks: they are different systems.
- Assuming R+W>N means strong consistency under a sloppy quorum.
- Using last-write-wins without acknowledging that it drops one of two concurrent writes.


---

## 🧒 Non-technical explanation

Imagine a **library with no head librarian**. Books (keys) are assigned to shelves around a circular hallway by a fixed rule, and each book is kept in **three** copies on three consecutive shelves. Any librarian can take your request, and they all know the map, so nobody has to ask a boss.

If a shelf is closed for repairs, the librarian puts your copy on the **next open shelf with a sticky note** ("belongs to shelf A, return when it reopens"). Two visitors might sometimes update different copies at the same time. Rather than refuse one of them, the library **keeps both versions** and lets a person (or a rule) merge them later. That choice, *never turn away a write*, is the whole personality of the system.

---

## TL;DR for engineers

- **Goal:** an "always writeable" key-value store that stays available through failures and partitions, with latency judged at the **99.9th percentile**, not the mean `[CONFIRMED]` (paper §2.2, §4.5).
- **Partitioning:** consistent hashing with **virtual nodes** (tokens), so load spreads evenly and nodes can differ in capacity `[CONFIRMED]` (§4.2).
- **Replication:** each key is stored on **N** nodes (clockwise successors, distinct physical nodes). A read needs **R** replies, a write needs **W**. R + W > N gives a quorum-like system. The common setting was **(N,R,W) = (3,2,2)** `[CONFIRMED]` (§4.3, §6).
- **Availability under failure:** a **sloppy quorum** plus **hinted handoff** keeps writes succeeding when a replica is down `[CONFIRMED]` (§4.6).
- **Conflicts:** **vector clocks** detect concurrent versions. Reads can return several, and the **client** reconciles `[CONFIRMED]` (§4.4). Some Amazon services instead used **last-write-wins by timestamp** `[CONFIRMED]` (§6).
- **Repair:** **Merkle-tree anti-entropy** for permanent divergence and **read repair** opportunistically `[CONFIRMED]` (§4.7, §5). **Gossip** spreads membership `[CONFIRMED]` (§4.8).
- **Zero-hop routing:** every node knows enough to route a request straight to the owners, avoiding multi-hop DHT latency variance `[CONFIRMED]` (§2/§4).

---

## 1. Requirements (as Dynamo's authors state them)

| Requirement | Detail | Source |
|---|---|---|
| Simple access | Key-value, blobs identified by key, no multi-item operations, no relational schema, objects "usually less than 1 MB". API is `get(key)` / `put(key, context, value)` | §2.1 `[CONFIRMED]` |
| Weak consistency accepted | Gives up ACID's "C" when it buys availability | §2.1 `[CONFIRMED]` |
| Always writeable | E.g. the shopping cart must accept adds even amid failures | §2.3 `[CONFIRMED]` |
| Latency SLA at the tail | The paper's example SLA: a response within **300 ms for 99.9%** of requests at a peak of 500 requests/s | §2.2 `[CONFIRMED]` |
| Incremental scalability | Add one node at a time | §2.3 `[CONFIRMED]` |
| Symmetric, decentralised | "Every node in Dynamo should have the same set of responsibilities as its peers" (symmetry), with decentralisation as its extension. Seeds exist only for discovery | §2.3 and §4.8 `[CONFIRMED]` |

**Reported production results** (paper §6, "past two years" as of 2007): successful responses for **99.9995%** of requests and **no data loss event to date** `[CONFIRMED]` (figures are the authors' claims about their own system at that time).

---

## 2. Partitioning: the ring with tokens `[CONFIRMED]` (§4.2)

Plain consistent hashing maps each node to one point on a ring. Dynamo's variant gives **each node many points ("tokens")**, so:
- when a node leaves, its load is **spread across the remaining nodes**,
- when a node joins, it takes a **roughly equal slice from each** other node,
- stronger machines can take **more tokens** (heterogeneity).

The paper compares three strategies for token placement (§6.2). **Strategy 3** (Q equal-size partitions, Q/S tokens per node) gave the **best load-balancing efficiency**, reduced the membership data each node carries **by three orders of magnitude** compared to Strategy 1, and was the one Amazon migrated to.

Cassandra's docs describe the same idea (virtual nodes) and say they "solve the problem by assigning multiple tokens in the token ring to each physical node" `[CONFIRMED]` (Cassandra docs).

---

## 3. Replication and quorums

```
ring:  A ── B ── C ── D ── E ── F ──┐
       └────────────────────────────┘
key k hashes between A and B → coordinator B, copies on C and D (N = 3)
preference list for k = [B, C, D, + extra nodes in case of failures]
```

- **N replicas** per key, chosen as the coordinator plus its N−1 clockwise successors, **skipping positions so all are distinct physical nodes** `[CONFIRMED]` (§4.3).
- The **preference list** holds more than N nodes to allow for failures `[CONFIRMED]`.
- **R** = minimum replies for a read, **W** = minimum acks for a write. **R + W > N** gives quorum-like behaviour. R and W are usually set **below N** because latency is set by the slowest of the R (or W) replicas `[CONFIRMED]` (§4.5).
- **(3,2,2)** was the common configuration `[CONFIRMED]` (§6). Other patterns the paper names: R=1, W=N for read-heavy services acting as a "high performance read engine", and W=1 for maximum write availability, though "most Amazon services in production set a higher W" `[CONFIRMED]`.
- **Cross-datacenter:** the preference list is built so replicas are **spread across multiple data centers**, so the loss of a whole data center does not cause an outage `[CONFIRMED]` (§4.6).
- **Write coordinator:** any of the top N nodes may coordinate a write, picked as the node that **replied fastest to the previous read**. The authors say always using the first node caused uneven load and SLA violations `[CONFIRMED]` (§5).

---

## 4. Surviving failures

### Sloppy quorum and hinted handoff `[CONFIRMED]` (§4.6)

Operations go to "the first N healthy nodes from the preference list", which may not be the first N on the ring. With N=3, if A is down, the replica meant for A goes to D with a **hint** naming A. D keeps hinted replicas in a separate store, scans it periodically and hands the data back when A returns. This keeps reads and writes from failing on temporary faults, at the price of weaker guarantees, because the "quorum" can include nodes that are not the usual owners.

### Anti-entropy with Merkle trees `[CONFIRMED]` (§4.7)

Hinted handoff fails when the hinted node disappears too. To catch lasting divergence, each node keeps a **Merkle tree per key range** (hash tree whose leaves hash individual keys). Two replicas compare roots, then walk down only the branches that differ, so little data is transferred.

### Read repair `[CONFIRMED]` (§5)

After a read returns, the coordinator waits briefly for the other replies. Replicas that returned stale versions get the latest one. This "relieves the anti-entropy protocol from having to do it".

---

## 5. Versioning and conflicts

Updates propagate asynchronously, so a `get` may return stale data (**eventual consistency**) `[CONFIRMED]` (§4.4).

**Vector clock** = list of `(node, counter)` pairs attached to each version. If every counter in clock X is ≤ the matching counter in clock Y, then X is an **ancestor** of Y and can be discarded. Otherwise they are **concurrent** and both must be kept `[CONFIRMED]`.

The paper's worked example (Figure 3):

| Step | Handler | Version | Clock |
|---|---|---|---|
| Write | Sx | D1 | [(Sx,1)] |
| Update | Sx | D2 (overwrites D1) | [(Sx,2)] |
| Update | Sy | D3 | [(Sx,2),(Sy,1)] |
| Another client reads D2, updates | Sz | D4 | [(Sx,2),(Sz,1)] |
| D3 and D4 are **concurrent** → reads return both | | | |
| Client merges, Sx coordinates | Sx | D5 | [(Sx,3),(Sy,1),(Sz,1)] |

**Clock truncation:** each pair carries a timestamp. When a clock exceeds a threshold ("say 10"), the **oldest pair is removed**. The authors acknowledge this can break descendant detection but say the problem "has not surfaced in production" `[CONFIRMED]` (§4.4).

**Who reconciles?** The paper lists three usage modes `[CONFIRMED]` (§6): **business-logic reconciliation** by the client (the shopping cart merges versions), **timestamp-based last-write-wins** (session information), and the **high-performance read engine** setup above.

**Cassandra's different choice** `[CONFIRMED]` (Cassandra docs): "Cassandra uses a simpler last-write-wins model where every mutation is timestamped", with no vector clocks. That is simpler to use, and it silently drops one of two concurrent writes.

---

## 6. Membership, discovery and routing `[CONFIRMED]` (§4.8)

- **Joins and leaves are explicit**, done by an administrator through a tool. The change is persisted with its time. A **gossip protocol** spreads membership changes: each node contacts a random peer **every second** and they reconcile their histories.
- Token assignments travel the same way, so every node knows which peers own which ranges and can **forward a request directly** (zero-hop).
- **Seeds**, known to all nodes via config or a configuration service, prevent logically partitioned rings.
- **Failure detection** is local: a node notices an unreachable peer when its own requests fail. The paper says an early decentralised failure-detector design that kept a global failure view was later found unnecessary given explicit join/leave.
- Cassandra, in contrast, runs a **Phi Accrual failure detector** on every node and gossips cluster bootstrap information once a second `[CONFIRMED]` (Cassandra docs).

---

## 7. Implementation notes `[CONFIRMED]` (§5)

Each node has three components: **request coordination**, **membership and failure detection**, and a **local persistence engine**. Written in Java. The coordination layer is event-driven (SEDA-style) and creates **one state machine per client request**. Storage engines were pluggable: Berkeley DB Transactional Data Store, BDB Java Edition, MySQL, or an in-memory buffer with a persistent backing store. The majority of production instances used BDB Transactional Data Store, chosen by object-size profile (BDB for objects typically "tens of kilobytes", MySQL for larger).

---

## 8. Cassandra vs the paper (per Cassandra's own docs) `[CONFIRMED]`

| Topic | Dynamo paper | Cassandra |
|---|---|---|
| Conflict handling | Vector clocks, client reconciliation (or LWW per service) | Last-write-wins on a per-mutation timestamp |
| Consistency knobs | (N,R,W) per instance | Consistency levels `ONE`, `QUORUM`, `ALL`… per request. Strong when `W + R > RF` |
| Write path | Coordinator sends to the N highest-ranked reachable nodes, waits for W | "Write operations are always sent to all replicas, regardless of consistency level" |
| Repair | Merkle-tree anti-entropy | Merkle trees, plus sub-range and incremental repair, which the docs say the paper does not have |
| Data model | Opaque key-value | "A storage interface that is more sophisticated" than simple key-value |
| Production placement | N/A | Docs: "All production deployments should use the `NetworkTopologyStrategy`" |

---

## ⚠️ Reviewer notes

1. **"Dynamo" is overloaded.** Interview answers often say "like DynamoDB" and then describe vector clocks and client reconciliation. Those are from the **2007 paper**. We did not verify what the DynamoDB service does internally, so do not assert it.
2. **"Consistent hashing" alone does not give balance.** The paper's own evolution (Strategy 1 → 3) shows that plain random tokens produced worse load balance and larger membership state. Say "virtual nodes with equal-size partitions" if asked about the details.
3. **The paper's R/W flexibility is often reduced to "AP system".** The authors say clients tune N, R, W to trade availability, durability and consistency, and that "low values of W and R can increase the risk of inconsistency". It is a dial, not a fixed point.
4. **Measured numbers are the authors' own and are from 2006–2007 hardware** (the latency figures were taken from a live (3,2,2) system with "a couple hundred nodes"). Do not quote them as current performance.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the paper. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **availability** (always writeable), **scalability** (incremental), **performance at the tail** (99.9th percentile), **durability**. **Consistency** is the one deliberately traded away.
- **Style (Ch 9–10):** **peer-to-peer / shared-nothing**, with **no coordinator tier**. Closest of the book's styles is **space-based** thinking (data partitioned and replicated across processing units, Ch 15), minus a central data grid.
- **Quanta (Ch 7):** one quantum **per ring**: every node is symmetric and shares the same fate for membership.
- **Trade-off (First Law, Ch 1):** **availability vs consistency.** Dynamo pushes conflict resolution to read time and to the application. The cost is application complexity, which the authors acknowledge.
- **ADR sketch (Ch 19):** *"We will accept writes with a sloppy quorum and reconcile on read. We accept that clients can see stale or conflicting versions, and must supply merge logic."*
- Plain English: the library never turns away a book, and the price is that sometimes you are handed two versions to merge yourself.

---

## Interview questions to practice

1. Walk through `put(k, v)` with N=3, W=2 when one replica is down. Where does the third copy go?
2. R=1, W=1, N=3: what can go wrong? What changes with R=2, W=2?
3. Two clients update the same key concurrently via different coordinators. Show the vector clocks and what the next read returns.
4. Why not always use last-write-wins? Give a case where it loses data.
5. A node was down for a day. How does it catch up (hints, read repair, anti-entropy)?
6. Why gossip, and what could go wrong with a ring that is "logically partitioned"?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: availability vs consistency, object size, scale.
2. Estimate: keys, replication factor, node count.
3. API: `get(key)` and `put(key, context, value)`.
4. Design: ring with virtual nodes, preference list, coordinator.
5. Deep dive: quorums, hinted handoff, vector clocks.
6. Failure and scale: node loss, permanent divergence, adding nodes.

**If it grows 10×**
- More nodes means more gossip state: keep the membership data compact (equal-size partitions did this).
- Hot keys: tune N, R and W per use and cache reads.
- Multi-datacenter: spread the preference list across sites.

**Answer outlines** (try the questions above first)

<details><summary>Walk through put with N=3, W=2 and one replica down.</summary>

The coordinator writes locally, sends to the other reachable nodes, and a stand-in node takes the down replica's copy with a hint. Two acks meet W, so the client gets success. The stand-in hands the replica back on recovery.

</details>

<details><summary>Why not always use last-write-wins?</summary>

It silently drops one of two concurrent writes. A shopping cart merge needs both. Vector clocks detect the concurrency so the application can merge.

</details>

<details><summary>A node was down for a day. How does it catch up?</summary>

Hinted replicas are delivered first, read repair fixes stale replicas opportunistically, and Merkle-tree anti-entropy repairs lasting divergence cheaply.

</details>

## 📚 Further reading

- [Dynamo paper (SOSP 2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- [Cassandra docs: Dynamo](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html)
- [Amazon DynamoDB, ATC '22](https://www.usenix.org/conference/atc22/presentation/elhemali) (the service, not the 2007 system)
- [System Design Primer: key-value store for a search engine, and the real-world architecture list](https://github.com/donnemartin/system-design-primer) (secondary)
- Related in this repo: [`neokim-post/04` Kafka](../../neokim-post/04-how-apache-kafka-works.md) for replication via ISR, a different approach to the same availability/consistency question.

## Sources and provenance

> **Kind:** real-system. This is the design in Amazon's 2007 Dynamo paper, compared against what Apache Cassandra's docs say it kept and changed.
> **Sources read on 2026-10-27:** [DeCandia et al., *Dynamo: Amazon's Highly Available Key-value Store*, SOSP 2007](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) (full text, 16 pages) · [Apache Cassandra docs: Dynamo](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html) · [USENIX ATC '22, *Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service*](https://www.usenix.org/conference/atc22/presentation/elhemali) (abstract only).
> **Not the same thing:** *Dynamo* (the 2007 paper, an internal Amazon system) and *DynamoDB* (the AWS service launched in 2012 `[CONFIRMED]` by the ATC '22 abstract) are different systems that share a name and some ideas. This note describes the paper. We did not read the DynamoDB paper in full, so we claim nothing about how the two differ internally.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice, no single authority · `[SPECULATIVE]` plausible design choice.

---
## ✅ Verification log

*Fact-check, 2026-10-27. The paper text was extracted from the PDF and each quoted claim was located in it.* No claim was changed, and four were softened or scoped (listed last).
- Verified in the paper: 99.9th-percentile SLA rationale and the 300 ms/500 rps example; "always writeable"; zero-hop DHT; virtual nodes and their three advantages; preference list with distinct physical nodes; R/W definitions and R+W>N; coordinator replicates to N−1 successors; sloppy quorum and hinted handoff mechanics with the A/D example; multi-datacenter preference lists; Merkle trees per key range; read repair; vector-clock rules, the Figure 3 example (re-derived by hand), truncation threshold "say 10"; gossip every second and reconciliation of membership histories; seeds; local failure detection; the three §6 usage modes; (3,2,2); Strategy 3 findings; 99.9995% and "no data loss event"; storage engines and Java implementation; write coordinator choice by fastest previous read.
- Verified in the Cassandra docs: tokens/vnodes quote; `NetworkTopologyStrategy` advice; `ONE`/`QUORUM`/`ALL`; `W + R > RF`; writes always sent to all replicas; LWW; Merkle trees; sub-range and incremental repair; Phi Accrual failure detector and one-second gossip; the stated differences from the paper.
- Verified in the ATC '22 abstract: DynamoDB launched in 2012.
- Softened: any statement on how DynamoDB's internals differ from Dynamo was **not made**, because the abstract does not say.
- Softened: the Figure 4 latency chart was **not quoted numerically**, since only the caption was read, not the plotted values.
- Scoped: the 99.9995% figure is attributed to the authors' own report for their first two years, not stated as a property of the design.
- Scoped: Architecture lens is explicitly our analysis.
