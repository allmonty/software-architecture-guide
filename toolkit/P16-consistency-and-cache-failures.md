# P16 — Consistency claims done right, and how caches fail

*A primer that corrects four shortcuts that interview notes often compress too far: the claims that CAP is pick two, that R + W > N means strong consistency, that the network is fine, and that a cache only speeds things up. Statements about CAP, PACELC, Dynamo and the fallacies come from the cited papers; the cache failure fixes are standard practice and labelled so.*

## At a glance

- CAP is not a menu of three letters of which you pick two. It says what a replicated store must give up **while a partition lasts**; the rest of the time the real trade-off is latency against consistency (PACELC).
- "Consistent" in CAP and in ACID are different properties.
- `R + W > N` gives a quorum-like system, not linearizability.
- Every remote call can fail, be slow or be repeated. The Eight Fallacies are the checklist.
- A cache adds a second mode of behaviour (hit or miss). Three failures follow: many misses for one key, repeated misses for keys that do not exist, and many keys expiring together.

---

## 1. CAP without "pick two" `[CONFIRMED]` (Brewer 2012, Abadi 2012)

Brewer, who proposed CAP, wrote twelve years later that "The "2 of 3" formulation was always misleading because it tended to oversimplify the tensions among properties." He adds that "because partitions are rare, there is little reason to forfeit C or A when the system is not partitioned." In practice that means a partition is an event the design must survive, not a property you can choose to leave out. A single-site database that is not replicated has no partition to tolerate, and a replicated one cannot decline to have partitions.

**The C in CAP is not the C in ACID.** Brewer describes the CAP consistency as single-copy consistency, "a strict subset of ACID consistency". ACID consistency is about keeping application invariants (constraints) true across a transaction. `[CONFIRMED]` in substance; the exact wording in the article has a stray character, so the phrase is quoted only in part.

## 2. PACELC: the trade-off you pay every day `[CONFIRMED]` (Abadi 2012)

Abadi restates CAP as: if there is a partition (P), trade availability against consistency (A and C); else (E), when running normally, trade latency against consistency (L and C). He notes that the latency/consistency trade-off "only applies to systems that replicate data". Examples from the paper: the default versions of Dynamo, Cassandra and Riak are PA/EL; fully ACID systems such as VoltDB/H-Store and Megastore are PC/EC.

**Why it matters in a design:** synchronous replication buys consistency by waiting for more replicas, so each write pays their latency. Say which side you chose and why (see [03 Key-value store](../systems/03-distributed-kv-store.md) and [P13 Multi-region](P13-multi-region-disaster-recovery.md)).

## 3. `R + W > N` is not linearizable `[CONFIRMED]` (Dynamo 2007, Abadi 2012)

The Dynamo paper says that setting R and W so that R + W > N yields a quorum-like system, and that R and W are usually set below N for better latency. It also says that a traditional quorum would make the system unavailable during failures, so Dynamo uses a sloppy quorum and hinted handoff: operations go to the first N healthy nodes, which may not be the usual replicas. Conflicts are resolved by vector clocks and the application, or by a simple policy such as last write wins.

Abadi states the consequence: these systems "cannot achieve full consistency as defined by Gilbert and Lynch, even if R + W > N". So a quorum inequality is a tuning knob, not a guarantee. Linearizable reads need a consensus-based or single-leader design (see [33 Coordination and locks](../systems/33-distributed-coordination-locks.md)).

## 4. The Eight Fallacies `[CONFIRMED]` (Deutsch)

Deutsch's list opens with "Essentially everyone, when they first build a distributed application, makes the following eight assumptions." They are: the network is reliable; latency is zero; bandwidth is infinite; the network is secure; topology doesn't change; there is one administrator; transport cost is zero; the network is homogeneous. The source page gives no explanation per item.

**Turning them into review questions** `[INDUSTRY PATTERN]`: what is the timeout on this call? What happens on retry (is it idempotent)? How big is the payload and how often? Who authenticates this hop? What if the target moved or was upgraded?

## 5. How caches fail `[CONFIRMED]` for the mechanisms, `[INDUSTRY PATTERN]` for the fixes

The AWS Builders' Library article on caching (Chhabra, 2019) describes the cache as introducing modal behavior, where behaviour differs by whether an object is cached, and warns that "An unanticipated shift in the distribution of this modal behavior can potentially lead to disaster." It names three situations we can use:

| Failure | What happens | Usual fix |
|---|---|---|
| **Stampede** (thundering herd) | Many clients need the same uncached resource, for instance after a hot key expires or a server starts with an empty cache. | Request coalescing: only one pending request per key; the article describes this. Leases and early refresh are in [32 Distributed cache](../systems/32-distributed-cache.md). |
| **Penetration** | Requests for keys that exist nowhere miss every time and reach the database. | Negative caching with its own TTL; the article says to cache the error response with a TTL different from positive entries. A Bloom filter in front is a common alternative `[INDUSTRY PATTERN]`. |
| **Avalanche** | Many keys expire at the same moment or the cache is lost, and all refresh at once. The article warns that discarding cached data "can lead to mass refreshes of caches". | Spread expiry with random jitter on the TTL, warm caches before taking traffic, and limit origin concurrency `[INDUSTRY PATTERN]`. |

Penetration and avalanche are common names, not terms from the cited article. The article says nothing about TTL jitter.

---

## Questions to practise

1. A colleague says our database is CP, so reads are always correct. What do you ask?
2. Why does `R = 2, W = 2, N = 3` not make a Dynamo-style store linearizable?
3. What does the ELC half of PACELC tell you about synchronous cross-region replication?
4. Pick three fallacies and show a code review comment that each would produce.
5. A hot key expires and the database CPU hits 100%. Give two fixes, and one more for a nightly job that loads a million keys with a one-hour TTL.

**Related:** [03 Key-value store](../systems/03-distributed-kv-store.md), [32 Distributed cache](../systems/32-distributed-cache.md), [P03 Distributed transactions](P03-distributed-transactions.md), [P13 Multi-region](P13-multi-region-disaster-recovery.md).

## Sources and provenance

> **Sources read on 2026-10-29:** Eric Brewer, [CAP Twelve Years Later: How the Rules Have Changed](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/) (IEEE Computer, 2012, read on InfoQ) · Daniel Abadi, [Consistency Tradeoffs in Modern Distributed Database System Design](https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf) (IEEE Computer, 2012) · DeCandia et al., [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) (SOSP 2007) · L. Peter Deutsch, [The Eight Fallacies of Distributed Computing](https://nighthacks.com/jag/res/Fallacies.html) (undated page) · Jas Chhabra, [Caching challenges and strategies](https://builder.aws.com/content/3K9TeXp6strMiJ4vhakpRD7BQWO/caching-challenges-and-strategies) (AWS, 2019-12-05)
> **Dated material:** The papers are from 2007 and 2012; the cited systems' defaults may have changed since.
> **Not read:** Gilbert and Lynch's CAP proof paper (its PDF text did not extract), current Cassandra, Riak and DynamoDB documentation, and any primary source that uses the names cache penetration or cache avalanche.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-29, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in Brewer's article (via the InfoQ copy): the "2 of 3" statement, the sentence about partitions being rare, and the subset relation to ACID consistency.
- Verified in Abadi's paper: the PACELC definition, the replication caveat, the PA/EL and PC/EC examples and the R + W > N statement.
- Verified in the Dynamo paper: the quorum-like sentence, sloppy quorum, hinted handoff and conflict resolution options.
- Verified in Deutsch's page: the introduction and the eight items.
- Verified in the AWS article: thundering herd, request coalescing, negative caching with a separate TTL, mass refreshes and modal behaviour.
- Not verified: that the AWS article names penetration, avalanche or TTL jitter (it does not); the Bloom filter and jitter fixes are standard practice, not sourced.
- Not verified: the Gilbert and Lynch definition itself; we rely on Abadi's reference to it.
