# P02 — Choosing a storage engine: B-tree, LSM and the rest

*A primer on the trade-off behind most database choices. The engine descriptions come from the PostgreSQL and RocksDB documentation; the decision guidance is our reasoning and is labelled.*

## At a glance

Most databases store data in one of two ways. A **B-tree** keeps data in sorted pages that are updated in place, which makes point reads and range scans on sorted data efficient `[INDUSTRY PATTERN]`. An **LSM tree** (log-structured merge tree) buffers writes in memory and a log, writes them as sorted immutable files, and merges files in the background (compaction). The engines are compared by **write, read and space amplification**: RocksDB's tuning guide uses these three ratios and says compaction changes the trade-off among them `[CONFIRMED]` (for the LSM side); applying the same lens to B-trees is standard practice `[INDUSTRY PATTERN]`. Pick the engine from the workload, not from fashion.

**In 60 seconds:** B-tree for read-heavy and mixed OLTP with range queries and strong transactional semantics; LSM for sustained write-heavy ingestion where background compaction cost is acceptable; and never answer "which database?" before stating the access pattern, consistency need and scale.

---

## 1. B-trees `[CONFIRMED]` (PostgreSQL documentation)

PostgreSQL provides several index types (B-tree, Hash, GiST, SP-GiST, GIN, BRIN and others), each suited to different kinds of clauses, and "by default, the CREATE INDEX command creates B-tree indexes, which fit the most common situations". B-trees "can handle equality and range queries on data that can be sorted into some ordering"; the planner considers one whenever an indexed column is compared with `<`, `<=`, `=`, `>=` or `>`. Other index types answer different questions: GIN is an inverted index for values with multiple components such as arrays, GiST is an infrastructure for strategies such as two-dimensional geometric data, SP-GiST supports non-balanced structures such as quadtrees and k-d trees, and BRIN stores summaries of consecutive block ranges, which works best when column values correlate with the physical row order. Our note [16 Reservation scheduler](../systems/16-reservation-scheduler.md) shows B-tree and GiST indexes enforcing correctness with exclusion constraints.

## 2. LSM trees `[CONFIRMED]` (RocksDB documentation)

RocksDB's three basic constructs are the **memtable** (an in-memory structure that takes new writes), the **sstfile** (sorted files on storage) and the **logfile** (a write-ahead log so a restart can replay what was only in memory). It keeps all data in sorted order, so point lookups and range scans are both supported, but a read may have to look in several files. When a memtable fills it is written out as a sorted file, and **compaction** merges files in the background to remove overwritten and deleted data and keep reads efficient.

**The three amplifications** (RocksDB's tuning guide):
- **Write amplification:** bytes written to storage versus bytes written to the database; its example is 10 MB/s of writes causing 30 MB/s of disk writes, an amplification of 3. High write amplification can bottleneck throughput and shortens flash lifetime.
- **Read amplification:** the number of disk reads per query.
- **Space amplification:** the size of the files on disk versus the size of the data.

**Compaction styles trade them off** (RocksDB's compaction page): classic **leveled** compaction "minimizes space amplification at the cost of read and write amplification"; **tiered** compaction "minimizes write amplification at the cost of read and space amplification"; leveled-N sits between. RocksDB implements a tiered+leveled hybrid (its default "level" compaction), a tiered style it calls universal, and FIFO. Tiered compaction can also need large transient space when merging the biggest sorted run.

## 3. Other families and where the atlas shows them `[INDUSTRY PATTERN]`

| Need | Typical choice | Atlas note |
|---|---|---|
| Transactions, joins, constraints, moderate scale | Relational database with B-tree indexes | [16 Reservations](../systems/16-reservation-scheduler.md), [17 Payments](../systems/17-payment-system.md) |
| Huge scale, simple key access, high availability | Partitioned key-value store (often LSM-based) | [03 Key-value store](../systems/03-distributed-kv-store.md), [09 Discord](../systems/09-discord.md) |
| Append-only streams and replay | Replicated log | [04 Kafka](../systems/04-message-queue-kafka.md) |
| Large blobs | Object storage | [05 S3](../systems/05-object-storage-s3.md), [07 Photos](../systems/07-photo-upload-storage.md) |
| Full-text search | Inverted index | [20 Search](../systems/20-web-crawler-search.md) |
| Time series | Compressed time-series store | [30 Monitoring](../systems/30-metrics-monitoring-alerting.md) |
| Similarity search | ANN index | [24 Vector search](../systems/24-vector-semantic-search.md) |
| Aggregates over events | Versioned aggregate store | [31 Ad clicks](../systems/31-ad-click-aggregation.md) |

## 4. How to answer "which database?" `[INDUSTRY PATTERN]`

1. State the **access patterns**: point reads, range scans, writes per second, read/write ratio, record size.
2. State the **consistency and transaction needs**: single-row or multi-row, whether you need joins, unique constraints or exclusion constraints.
3. State the **scale and availability** needs: one node with replicas, or partitioning across many nodes, and across regions.
4. Name the **default** (a relational database is the right answer more often than interviews suggest), then name what would make you leave it: write volume beyond one primary, key-value access at very large scale, or a special query type.
5. Say what you give up: for an LSM engine, read and space amplification and compaction tuning; for a B-tree engine, write amplification for random updates and in-place page updates.
6. Mention operations: backups and restore time (see [C03 GitHub 2018](C03-github-2018.md)), schema changes, and the team's experience.

---

## Questions to practise

1. Why can an LSM tree sustain heavier write loads than a B-tree on the same disk, and what does it pay for it?
2. What are write, read and space amplification? Give a workload where each matters most.
3. When would you choose tiered over leveled compaction?
4. When is a relational database still the right answer at large scale?
5. A table needs range queries by timestamp and point lookups by id. What indexes would you build?

## Practice

For each system in the atlas table above, write one sentence on why its storage choice fits its access pattern, then one on what would make you change it.

**Related:** [03 Key-value store](../systems/03-distributed-kv-store.md), [09 Discord](../systems/09-discord.md), [16 Reservation scheduler](../systems/16-reservation-scheduler.md), [C03 GitHub 2018](C03-github-2018.md).

## Sources and provenance

> **Sources read on 2026-10-27:** PostgreSQL documentation, [11.2 Index Types](https://www.postgresql.org/docs/current/indexes-types.html) · RocksDB wiki, [RocksDB Overview](https://github.com/facebook/rocksdb/wiki/RocksDB-Overview), [Compaction](https://github.com/facebook/rocksdb/wiki/Compaction) and [Tuning Guide](https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide) (read from the wiki's source text).
> **Dated material:** Documentation pages as of 2026-10-27; RocksDB's page cites the O'Neil et al. LSM paper and the Dostoevsky paper, which we did not read.
> **Not read:** The original LSM-tree paper, the Bigtable paper (its PDF text did not extract), Dostoevsky, and comparisons of storage engines on benchmark workloads.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the PostgreSQL page: the list of index types, B-tree as the default, and the equality and range statement.
- Verified in the RocksDB pages: memtable, sstfile and logfile, the three amplification definitions and example, and the leveled, tiered and RocksDB implementation statements.
- Not sourced (our reasoning): the decision guide, the table of needs, and the interview procedure.
