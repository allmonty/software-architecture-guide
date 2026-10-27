# 33 — Distributed Coordination, Locks and Leader Election

*Real-system note from the Chubby (Google, 2006), ZooKeeper (Yahoo!, 2010) and Raft (2014) papers, plus a reference design for using them. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Many distributed systems need a small piece of strongly consistent state: who is the leader, who holds this lock, what is the current configuration. Instead of every system solving consensus itself, a small replicated **coordination service** (Chubby, ZooKeeper, etcd-style) provides files or nodes, locks, sessions and notifications. The service runs a consensus protocol among a handful of replicas (typically five) and clients talk to it. The classic traps are using a lock without **fencing** (a paused client resumes after its lock expired and corrupts data), hammering the service with **fine-grained** locking, and building on timing assumptions that fail.

**Key numbers** (as published)
- A Chubby cell is typically **five replicas**; a new master is typically elected in a few seconds (the paper reports two recent elections that took 6 s and 4 s, and values as high as 30 s) `[CONFIRMED]`.
- Chubby cells served tens of thousands of clients each; the design favours availability and reliability over throughput `[CONFIRMED]`.
- ZooKeeper handled tens to hundreds of thousands of transactions per second for read-to-write ratios from 2:1 to 100:1 `[CONFIRMED]`.
- Raft elects leaders with randomized timeouts chosen from a fixed interval such as 150 to 300 ms `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| A separate coordination service | One careful consensus implementation, shared | Another critical dependency; low throughput by design |
| Coarse-grained locks and leases | Light load on the service | Slow handover on failure |
| Sequencers / fencing tokens on protected resources | A stale lock holder cannot corrupt data | Resource servers must check them |
| Reads served by followers (ZooKeeper) | Scales read-heavy workloads | Reads may be slightly stale unless synced |
| Odd number of replicas, majority quorum | Tolerates minority failures | Unavailable without a majority |

**Common mistakes**
- Assuming a lock guarantees mutual exclusion even after a process pauses, loses its session or has a delayed message.
- Using the coordination service as a general database or queue.
- Fine-grained locking through the service, which overloads it.
- Even-sized clusters and clusters spread over distant sites, which hurt availability or latency.

---

## 🧒 Non-technical explanation

Imagine a **town clerk** who keeps the one official record of who owns the key to the shared tool shed. Five clerks keep identical books and vote so that a majority always agrees. When you take the key you also get a numbered ticket; the shed refuses any visitor whose ticket is older than the latest one it has seen. If you fall asleep holding the key and wake up an hour later, the shed rejects your old ticket even though you still believe you own it. The clerks do not run the town; they only settle who is in charge.

---

## TL;DR for engineers

- **Chubby:** a lock service with a file-system interface, advisory locks, sessions, events, and sequencers; built on Paxos replicas with a master lease `[CONFIRMED]`.
- **ZooKeeper:** a wait-free coordination kernel: hierarchical znodes, ephemeral and sequential flags, watches, FIFO client order and linearizable writes `[CONFIRMED]`.
- **Raft:** consensus decomposed into leader election, log replication and safety, designed to be understandable `[CONFIRMED]`.
- **Locks without herds and with fencing:** the ZooKeeper recipe and Chubby sequencers `[CONFIRMED]`.
- **Choosing leases, timeouts and what to protect:** reference guidance `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** elect a leader · mutual exclusion over a resource · store small configuration and membership · notify clients of changes · detect failed clients.

**Non-functional:** **correctness** (never two leaders for the same period, or at least detect it) · **availability** of the service itself · **low load** (it is not a data path) · **bounded failure detection time** · **simple semantics** for developers.

**Clarifying questions:** what exactly needs mutual exclusion, and what is the cost of two holders at once? How quickly must failover happen? How many clients and lock operations per second? Can the protected resource check a token?

---

## 2. Chubby: a lock service `[CONFIRMED]` (Burrows, OSDI 2006)

Chubby is described as a service "intended to provide coarse-grained locking as well as reliable (though low-volume) storage for a loosely-coupled distributed system", with an interface like a distributed file system with advisory locks and "the design emphasis is on availability and reliability, as opposed to high performance".

- **Cell:** "a small set of servers (typically five) known as replicas" placed to reduce correlated failure. The replicas use a consensus protocol to elect a master, which must win a majority of votes plus promises that the replicas will not elect another master for an interval of a few seconds, the **master lease**, renewed periodically. Only the master initiates reads and writes; writes are acknowledged when they reach a majority; reads are served by the master alone, which is safe while the master lease has not expired. If the master fails a new one is typically elected in a few seconds (with values as high as 30 s reported).
- **Coarse-grained use:** the paper argues that coarse-grained locks, held for hours or days and acquired rarely, impose far less load on the lock server and are less affected by its failures than fine-grained locks; developers who need fine-grained locking should implement their own, using Chubby coarse locks to allocate groups of resources.
- **Advisory locks:** any file or directory can act as a reader-writer lock; locks are advisory, so they conflict only with other attempts to acquire the same lock. The authors rejected mandatory locks.
- **Sequencers:** a lock holder can request a **sequencer**, "an opaque byte-string that describes the state of the lock immediately after acquisition", containing the lock name, mode and a lock generation number. The client passes it to servers it expects the lock to protect, and the server checks whether it is still valid and rejects stale requests. This addresses delayed or re-ordered messages from a holder that no longer holds the lock.
- **Lock-delay:** for servers that cannot check sequencers, if a lock becomes free because its holder failed or became inaccessible, the lock server prevents others from claiming it for a lock-delay (up to one minute), which "protects unmodified servers and clients from everyday problems caused by message delays and restarts".
- **Sessions:** a client keeps a session with the master through periodic KeepAlive calls; locks and handles remain valid as long as the session does.
- **Electing a leader:** the paper's example of use: candidates try to acquire a lock; the winner writes its identity to a file, and others read it.

## 3. ZooKeeper: a coordination kernel `[CONFIRMED]` (Hunt et al., ATC 2010)

ZooKeeper aims "to provide a simple and high performance kernel for building more complex coordination primitives at the client". Its interface has the "wait-free aspects of shared registers with an event-driven mechanism similar to cache invalidations". Guarantees: **FIFO execution of requests per client** and **linearizability for all requests that change state**; read requests are satisfied by local servers, so reads scale, and for the target workloads (2:1 to 100:1 read to write) it handled tens to hundreds of thousands of transactions per second.

- **Data model:** a hierarchy of **znodes**; clients can create regular or **ephemeral** znodes (deleted automatically when the session ends), and can request a **sequential** flag that appends a monotonically increasing counter to the name. **Watches** notify a client once when a znode changes.
- **Lock recipe without a herd effect (from the paper):** a client creates an ephemeral sequential znode under the lock node; if its znode has the lowest sequence number it holds the lock; otherwise it watches only the znode just before its own, so only one client wakes when a lock is released. Crashed clients' ephemeral znodes disappear automatically.
- The paper states that ZooKeeper is not a lock service itself; locks, leader election, group membership and configuration are recipes built on its primitives.

## 4. Raft: consensus made understandable `[CONFIRMED]` (Ongaro and Ousterhout, 2014)

Raft separates "the key elements of consensus, such as leader election, log replication, and safety" and enforces a stronger degree of coherency to reduce the number of states to consider. Properties the paper lists as true at all times include **election safety** (at most one leader can be elected in a given term), **leader append-only**, **log matching**, **leader completeness** (a committed entry is present in the logs of all later leaders) and **state machine safety**. Leader election uses randomized timeouts (for example 150 to 300 ms) so that split votes are rare and resolved quickly, and membership changes use joint consensus with overlapping majorities. Systems like etcd and Consul build their coordination on this kind of replicated log (not read here).

---

## 5. Reference design: using a coordination service `[INDUSTRY PATTERN]`

```
workers ─► coordination cluster (3 or 5 replicas, majority quorum) ◄─ clients (leader election, locks, config)
   │                │ sessions / leases + sequence numbers (fencing tokens)
   └────────────────┴──► protected resource (storage, job executor) checks the token
```

- **Leader election:** each candidate tries to create an ephemeral node or acquire a lock; the holder is leader; others watch. Keep leader work small and idempotent.
- **Fencing:** every lock acquisition returns a monotonically increasing token; the protected resource remembers the highest token it has seen and rejects lower ones. A lease or session timeout alone cannot prevent a paused process from acting after expiry.
- **Leases:** hold a lock for a bounded time and renew it; choose the timeout from the worst plausible pause (garbage collection, network delay), and make leader duties safe if the lease expires mid-operation.
- **Sizing:** three or five replicas; keep them in one region or low-latency sites; avoid even sizes.
- **Load:** use the service for control-plane decisions, not per-request locking; cache results client-side with notifications.
- **Failure of the service:** clients must handle losing the session: stop acting as leader, release resources, and retry.
- **Alternatives:** a database row with a conditional update, or a lease table, is often enough for single-tenant or low-stakes cases; say what you give up (consensus guarantees, notifications).

---

## 6. Failure scenarios

- **A lock holder pauses and loses its session.** Another client acquires the lock; when the first resumes, the resource server rejects its old sequencer `[CONFIRMED]` (Chubby).
- **The master of the coordination cluster fails.** The replicas elect a new master after the lease expires, typically in a few seconds; clients retry `[CONFIRMED]`.
- **A network partition.** The side with a majority continues; the minority cannot elect a leader or accept writes, because writes need acknowledgement from a majority `[CONFIRMED]` (Chubby: writes are acknowledged when they reach a majority of replicas); what clients on the minority side do is a design choice `[INDUSTRY PATTERN]`.
- **Herd on lock release.** The sequential-znode recipe wakes only the next waiter `[CONFIRMED]`.
- **Clock or timing assumptions fail.** Protect resources with tokens rather than relying only on timeouts `[INDUSTRY PATTERN]`.

---

## 7. Capacity reasoning (illustrative)

- Coordination traffic ≈ number of clients × session renewal frequency + lock events. With 10,000 clients renewing every 10 seconds the service sees about 1,000 renewals per second (our arithmetic), which is trivial for it; fine-grained locking at 100,000 operations per second is not.
- Availability with N replicas tolerates ⌊(N−1)/2⌋ failures: 3 tolerates 1, 5 tolerates 2.
- Failover time ≈ lease or timeout plus election time (seconds); that is also the unavailable window for leader-dependent work.

---

## ⚠️ Reviewer notes

1. **The papers are from 2006 to 2014** and describe Google, Yahoo! and academic designs; modern services such as etcd differ in details.
2. **Fencing is stated in Chubby's paper as the sequencer mechanism;** the general argument that timeouts alone cannot ensure mutual exclusion under pauses is standard but is not proved in these papers.
3. **ZooKeeper reads are served locally,** so they may return stale data unless the client syncs; the paper's guarantee is linearizable writes and FIFO client order, not linearizable reads.
4. **Not read:** the Paxos papers, etcd and Consul documentation, Google Spanner's use of leases, and critiques of distributed locks.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the papers. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **reliability/consistency** of the control plane, **availability**, **simplicity**.
- **Style (Ch 13):** a small **replicated service** used by many clients as a shared control plane.
- **Quanta (Ch 7):** the coordination cluster is a single quantum on which many systems depend; that dependency is the architectural risk.
- **Trade-off (First Law, Ch 1):** **consistency vs availability.** It chooses consistency for a tiny amount of state and accepts unavailability without a majority.
- **ADR sketch (Ch 19):** *"We will use a three-node coordination service for leader election and configuration, and protect shared resources with fencing tokens. We accept a dependency on its availability in exchange for correct leader selection."*
- Plain English: one official record-keeper, a numbered ticket, and a shed that checks tickets.

---

## Interview questions to practice

1. How would you implement a distributed lock? What can go wrong?
2. What is a fencing token and why is a lease not enough?
3. How does leader election work in Raft? How do you avoid split votes?
4. Why does a coordination service run on 3 or 5 nodes?
5. How would you build a lock in ZooKeeper without a herd effect?
6. When should you not use a distributed lock?
7. What happens to leader-only work during a network partition?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the papers.

**A 45-minute walkthrough**

1. Clarify: what is being protected, the cost of two holders, failover time, scale.
2. Estimate: clients, session renewals, lock operations per second ([P01](../toolkit/P01-estimation.md)).
3. API: acquire with lease, renew, release, get token; watch for changes.
4. Design: replicated coordination cluster, client library with sessions, protected resource that checks tokens.
5. Deep dive: leases, pauses, fencing, election and failover timing.
6. Failure and scale: partition, master failure, herd on release, many clients.

**If it grows 10×**
- Coarse-grained locks only; shard the problem so each group has its own leader.
- Use client-side caching with notifications; add proxy tiers if needed.
- Add observer replicas for reads rather than voting members.

**Answer outlines** (try the questions above first)

<details><summary>What is a fencing token and why is a lease not enough?</summary>

A fencing token is a number that increases every time a lock is granted. The resource remembers the highest token seen and rejects lower ones. A lease can expire while the holder is paused, so the holder wakes up believing it still owns the lock; the resource's check, not the holder's belief, protects the data.

</details>

<details><summary>How does Raft avoid split votes?</summary>

Followers wait a randomized election timeout (for example 150 to 300 ms). The first to time out becomes a candidate, increments its term and requests votes; others vote for at most one candidate per term, and a majority wins. Randomization makes simultaneous candidacies rare and resolves them quickly.

</details>

<details><summary>When should you avoid a distributed lock?</summary>

When the operation can be made idempotent, or when a conditional write (compare and set) in the datastore itself can enforce the invariant. Locks add a dependency and failure modes; use them for coarse leadership or rare critical sections, not per-request protection.

</details>

## 📚 Further reading

- The papers listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [03 Distributed key-value store](03-distributed-kv-store.md) (quorums), [04 Kafka](04-message-queue-kafka.md) (controller and KRaft), [19 Stock exchange](19-stock-exchange.md) (sequencer), [C03 GitHub 2018](../toolkit/C03-github-2018.md) (Raft-based failover gone wrong), [P03 Distributed transactions](../toolkit/P03-distributed-transactions.md).

## Sources and provenance

> **Kind:** real systems (Chubby, ZooKeeper) and a published algorithm (Raft), with a reference design for using them `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (PDF text extracted locally):** Burrows, [*The Chubby Lock Service for Loosely-Coupled Distributed Systems*](https://static.googleusercontent.com/media/research.google.com/en//archive/chubby-osdi06.pdf) (OSDI 2006) · Hunt et al., [*ZooKeeper: Wait-free coordination for Internet-scale systems*](https://www.usenix.org/legacy/event/atc10/tech/full_papers/Hunt.pdf) (USENIX ATC 2010) · Ongaro and Ousterhout, [*In Search of an Understandable Consensus Algorithm*](https://raft.github.io/raft.pdf) (extended version, 2014).
> **Dated material:** 2006 to 2014.
> **Not read:** the Paxos papers, etcd and Consul documentation, Spanner, and published critiques of lock-based designs.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the Chubby paper: purpose and emphasis, five replicas, master lease and election, read and write paths, coarse-grained reasoning, advisory locks, sequencers, lock-delay (up to one minute), sessions and KeepAlives.
- Verified in the ZooKeeper paper: abstract statements (wait-free, FIFO client order, linearizable writes, local reads, 2:1 to 100:1, tens to hundreds of thousands of transactions per second), znode flags, and the herd-free lock recipe.
- Verified in the Raft paper: the decomposition into leader election, log replication and safety, the listed safety properties, randomized timeouts (150 to 300 ms) and joint consensus.
- Not sourced (our reasoning): the reference design, lease-sizing advice, capacity arithmetic and interview outlines.
- Not claimed: the behaviour of etcd, Consul or any current service.
