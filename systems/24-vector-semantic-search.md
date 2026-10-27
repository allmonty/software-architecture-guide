# 24 — Vector / Semantic Search at Scale

*A reference design built on three published index designs (HNSW, DiskANN, Faiss). How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Semantic search turns items (documents, images, products) into vectors and finds the ones nearest to a query vector. Exact search compares the query with every vector, which does not scale, so production systems use **approximate nearest neighbour (ANN)** indexes that trade a little recall for a lot of speed. The main families are graph indexes (HNSW), clustered indexes with compressed vectors (IVF with product quantization, as in Faiss), and SSD-resident graphs (DiskANN). At scale you also shard the index, filter by metadata, absorb fresh writes and rebuild when the embedding model changes. The core trade-off is **recall versus latency versus memory**.

**Key numbers** (as published, in the authors' tests)
- DiskANN indexes and serves a billion-point database on one machine with 64 GB of RAM and an SSD, at over 5,000 queries a second with under 3 ms mean latency and 95%+ 1-recall@1 on SIFT1B `[CONFIRMED]` (NeurIPS 2019).
- The same paper says compressed-vector indexes with a small memory footprint reach only around 0.5 1-recall@1, because compression is lossy `[CONFIRMED]`.
- A reported production example sharded 2 billion 128-dimension points across 32 machines, querying every shard and aggregating, for 100-recall@100 of 0.98 at about 5 ms `[CONFIRMED]` (quoted in the DiskANN paper, citing another source).
- HNSW's search complexity scales logarithmically, and a reasonable range of its connection parameter M is 5 to 48, with memory proportional to M `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Graph index in RAM (HNSW) | Best speed at high recall | Memory for vectors plus graph edges |
| Compressed vectors (product quantization) | Fits far more vectors in RAM | Lossy: lower recall unless you re-score |
| SSD-resident graph (DiskANN) | 5–10× more points per node than in-memory graphs | Few dozen random SSD reads per query to engineer for |
| Shard and fan out | Capacity beyond one machine | Every query hits every shard; tail latency of the slowest shard |
| Filter during search | Metadata conditions are common | Filtering can hurt recall or speed if done naively |

**Common mistakes**
- Quoting "recall" without saying at what k. 1-recall@1 and 100-recall@100 are very different bars.
- Sizing from vector bytes alone and forgetting the graph or index overhead.
- Choosing an index before measuring recall on your own embeddings; results depend on the data.
- Forgetting that changing the embedding model changes every vector, so the whole index must be rebuilt.

---

## 🧒 Non-technical explanation

Imagine a **huge library where books are shelved by meaning, not by title**: cookbooks near other cookbooks, but also "Italian travel" near "Italian food". Finding the closest book to a question by comparing it with every book would take forever. So the library keeps a **map of shortcuts**: from any book you can hop to a few close neighbours, and a few long-range hops let you cross the building fast. You start at a landmark, keep hopping toward the question, and stop when no neighbour is closer. You might miss the absolute best book occasionally, but you find a very good one in a dozen hops.

---

## TL;DR for engineers

- **Exact nearest-neighbour search** is a linear scan. ANN indexes give up some recall for speed `[CONFIRMED]`.
- **HNSW:** a multi-layer proximity graph; each element's top layer is chosen randomly with exponentially decaying probability; search starts at the top layer and descends `[CONFIRMED]`.
- **IVF plus product quantization (Faiss):** cluster the vectors, search only the nearest clusters, and store compressed codes `[CONFIRMED]`.
- **DiskANN:** a graph (Vamana) and full vectors on SSD, compressed vectors in RAM, beam search to cut SSD round trips `[CONFIRMED]`.
- **Sharding, filtering, freshness and re-indexing** are the platform concerns `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** insert and update vectors with ids and metadata · query by vector or text and return the k nearest · filter by metadata · delete.

**Non-functional:** **latency** (single-digit to tens of milliseconds) · **recall** targets · **scale** (millions to billions of vectors) · **freshness** of new writes · **cost** (memory dominates) · **availability** · **throughput**.

**Clarifying questions:** number of vectors and dimensions? Query rate and latency target? Required recall, and at what k? How fresh must new items be? What filters are needed? How often does the embedding model change? Is the data multi-tenant?

---

## 2. Why exact search fails, and what ANN trades `[CONFIRMED]`

The Faiss paper (Douze et al., arXiv 2401.08281) describes vector search as the core function of vector databases, and describes it as a set of **trade-offs** between accuracy, search time, memory usage, index building time and, for flash or distributed storage, the number of I/O operations.

The DiskANN paper puts it plainly: "it is often impossible to retrieve the exact nearest neighbors without essentially resorting to a linear scan of the data", because of the curse of dimensionality, so systems retrieve approximate neighbours and measure **k-recall@k**: the fraction of the true k nearest neighbours that the search returns.

**Metric choice.** The Faiss paper shows how to reduce L2 distance, inner product and cosine similarity to one another by preprocessing the vectors, so one index type can serve several metrics. For cosine, normalise the vectors.

---

## 3. Index families

### 3.1 HNSW: a layered proximity graph `[CONFIRMED]` (Malkov and Yashunin)

The Hierarchical Navigable Small World index is "fully graph-based", with a multi-layer structure of proximity graphs over nested subsets of the elements. Each element's maximum layer is chosen randomly with an exponentially decaying probability, so upper layers are sparse. Search starts at the top layer and greedily moves toward the query, descending layers; this gives **logarithmic complexity scaling**, and the authors note the similarity to a **skip list**. A heuristic for choosing each element's neighbours improves performance at high recall and on clustered data.

**Parameters.** The user-facing construction parameter is M (connections per element); the authors suggest 5 to 48, smaller M for lower recall or lower dimensional data and larger M for high recall or high-dimensional data. Memory use is proportional to M. A build-time candidate-list size (efConstruction) should be large enough for recall near 1 during construction, and a search-time list size (ef) controls the recall and speed of queries.

**What the paper does not give us.** Its focus is search and insertion. We found no deletion procedure in the text we read, so we make no claim about how to delete from an HNSW graph beyond what other sources state.

### 3.2 IVF and product quantization (Faiss) `[CONFIRMED]`

**Inverted file (IVF).** Database vectors are clustered with a coarse quantizer, and vectors of each cluster are stored in inverted lists. At search time only a subset of the clusters is visited (the `nprobe` setting): the ones with the nearest centroids. More lists visited raise recall and cost.

**Compression.** Product quantization compresses vectors into short codes so far more fit in memory, at the price of accuracy; the Faiss paper presents it as often giving a good trade-off between code size and accuracy. The DiskANN paper reports that this class of method has a small footprint (under 64 GB for a billion 128-dimension points) and answers in under 5 ms with accelerators, but its 1-recall@1 is rather low (around 0.5) because the compression is lossy. Higher recall appears only for the weaker measure of 1-recall@100 (the true nearest neighbour appears somewhere in 100 candidates), a measure the paper says "may not be acceptable in many applications".

**Library scope.** Faiss describes itself as a toolkit, not a service or database: it "does not provide concurrent write access, load balancing, sharding, transaction management or query optimization". It supports adding and removing vectors by id, and filtered search through a predicate on ids, but it "does not store arbitrary metadata with the vectors". Filtering on metadata therefore means an indirection to a separate metadata table or packing small attributes into unused id bits. When the data distribution changes substantially, index structures such as IVF and compression degrade and need explicit updates.

### 3.3 DiskANN: a billion points on one machine `[CONFIRMED]` (Subramanya et al., NeurIPS 2019)

**Problem.** In-memory graph indexes are expensive. The paper's example: an NSG index for 100 million 128-dimension float vectors needs about 75 GB (assuming a graph degree of 50), so a billion points needs several machines. Sharding approaches route every query to every shard and aggregate; the paper cites a reported Taobao deployment with 2 billion points in 32 shards.

**Design.** DiskANN builds a **Vamana** graph and stores "the graph along with the full-precision vectors on the SSD" while keeping "the compressed vectors of all the data points in memory". Search uses the compressed vectors to decide which neighbourhoods to read from disk. To limit round trips it uses **BeamSearch**: it fetches the neighbourhoods of a small number W (say 4 or 8) of the closest candidates in one shot, because reading a few random sectors costs about the same as reading one. Too large a W (16 or more) wastes compute and SSD bandwidth. The paper states the SSD engineering target: a few dozen random reads per query and under ten (preferably five) round trips.

**Building at scale.** To index a billion points without holding them in memory, it partitions the data into k clusters (for example 40) with k-means, assigns each point to multiple nearby clusters, builds a Vamana graph per cluster in memory, and merges the graphs by taking the union of edges. The overlap keeps the merged graph connected.

**Results.** On SIFT1B with a 16-core machine: over 5,000 queries a second, under 3 ms mean latency, 95%+ 1-recall@1; in the high-recall regime it serves 5–10× more points per node than HNSW and NSG. These are the authors' measurements on one dataset and one machine class.

**What the paper does not give us.** It builds static indexes; updates are the subject of the follow-up paper below.

### 3.4 Updates on a graph index: FreshDiskANN `[CONFIRMED]` (Singh et al., 2021)

The follow-up paper starts from exactly the gap above: existing graph indexes "support only static indices that cannot reflect real-time changes to the corpus", so the "current industry practice" is to rebuild periodically, "which can be prohibitively expensive". It also shows that simple update rules degrade the quality of HNSW and NSG graphs over a stream of inserts and deletes. Its design:
- **FreshVamana**, a graph index with insert and delete rules that stay stable over long update streams. Deletes are **lazy**: a deleted point goes into a DeleteList without changing the graph; during search those nodes are still used for navigation but filtered out of the results. After 1–10% of the index has been deleted, a batch **delete consolidation** repairs the neighbourhoods of the points that pointed at deleted nodes.
- **System shape:** a long-term SSD-resident index over most points plus a short-term in-memory index for recent updates; a background **StreamingMerge** folds the short-term index into the long-term one, with cost proportional to the change set, not the whole index.
- **Reported results** (week-long runs on a nearly billion-point SIFT1B subset, 48 cores, 3.2 TB SSD): under 128 GB of DRAM at all times; a steady 1,800 inserts and 1,800 deletes per second (bursts up to 40,000 inserts per second); update latency under 1 ms even during a merge; 1,000 searches per second with 95%+ 5-recall@5 and mean latency well under 20 ms; a merge of a 10% change in about 10% of the time of a rebuild; and a claimed 5–10 times reduction in the cost of maintaining freshness compared with existing methods (the paper does not frame it as a comparison with rebuilding only).

This is the published version of the small-fresh-index-plus-periodic-merge pattern used in section 4. These figures are the authors' on one dataset and machine.

---

## 4. The platform around the index `[INDUSTRY PATTERN]`

```
app ─► embed query ─► coordinator ─► shard 1 … shard N (replicas) ─► top-K per shard ─► merge ─► results
                          └────────► fresh-writes index ─────────────┘
source ─► embed ─► fresh-writes index ─► periodic build ─► index segments in object storage ─► shards load
```

- **Sharding and fan-out:** split vectors across shards; the coordinator queries all shards (or a chosen subset if the data is partitioned by tenant or category) and merges the top-K lists. The slowest shard sets the latency, so use replicas and timeouts. The Taobao figure in section 3.3 is a published example of this shape.
- **Replicas:** replicate each shard for availability and throughput; route queries to the least-loaded healthy replica.
- **Filtering:** apply the filter inside the search (checking each candidate's attributes as the graph is traversed), after it (post-filter and over-fetch), or by partitioning the index by the filter key. pgvector's documentation is a concrete example of the trade-off: with approximate indexes, filtering is applied after the index is scanned, so if a condition matches 10% of rows and the HNSW candidate list (`ef_search`) is the default 40, only 4 rows match on average `[CONFIRMED]`. It offers iterative index scans (from version 0.8.0) that keep scanning until enough results are found, partial indexes for a few filter values, and partitioning for many. Strong filters make post-filtering waste results; tune and measure recall under filters.
- **Freshness:** write new vectors into a small in-memory index that is queried alongside the main one, and fold them into the main index in periodic builds. Deletes are tombstones applied at query time until the next rebuild or consolidation, as in FreshDiskANN's DeleteList.
- **Embedding model changes:** every vector changes, so build a new index beside the old, validate recall on a labelled set, then switch traffic (blue/green) and keep the old one for rollback.
- **Hybrid search:** combine with keyword search for exact terms; see [23 RAG knowledge assistant](23-rag-knowledge-assistant.md) for why.
- **Quality monitoring:** keep a labelled query set, compute recall of the ANN index against exact search on a sample, and alert when it drops.

---

## 5. Capacity reasoning (illustrative)

- **Raw vector bytes** = vectors × dimensions × bytes per number. One billion 128-dimension vectors at 1 byte (like SIFT1B's uint8) is 128 GB; at 768 dimensions in 4-byte floats it is about 3 TB.
- **Compressed codes:** at 32 bytes per vector (the example size in the DiskANN paper) a billion vectors take about 32 GB.
- **Graph overhead:** edges per vector × id size. With 64 neighbours of 4 bytes each, 256 bytes per vector on top of the vector itself; the exact figure depends on the index and its parameters.
- **Shards** = total memory needed ÷ usable memory per machine, then multiply by replicas for availability.
- These are our arithmetic, and the dimensions, precision and degree are assumptions.

---

## 6. Failure scenarios

- **A shard is slow or down.** The coordinator must choose between waiting, retrying another replica, or returning partial results. A timeout with a replica retry is the usual compromise `[INDUSTRY PATTERN]`.
- **Recall drops silently.** Data drift, aggressive compression or too small a search list lowers recall without errors; monitor against exact search on samples `[INDUSTRY PATTERN]`.
- **Filter makes results empty or poor.** A restrictive filter applied after retrieval leaves too few results; over-fetch or use filtered traversal `[INDUSTRY PATTERN]`.
- **Memory pressure.** An index that no longer fits in RAM degrades sharply, which is what DiskANN's design addresses by moving full vectors to SSD `[CONFIRMED]` for that design.
- **Index rebuild fails.** Keep the previous index serving and roll forward only after validation `[INDUSTRY PATTERN]`.

---

## ⚠️ Reviewer notes

1. **Recall numbers are not comparable across papers.** They use different datasets, hardware, k and recall definitions. We quote each with its definition.
2. **The DiskANN comparison with Faiss is from 2019.** The paper says Faiss "supports searching only from RAM" quoting a Faiss blog post at that time; later Faiss versions may differ, and we did not check.
3. **The Taobao sharding figure is second-hand:** the DiskANN paper reports it citing another paper, and we did not read the original.
4. **Deletes and updates:** the HNSW and original DiskANN papers do not cover them; FreshDiskANN (section 3.4) does for the Vamana graph, on one dataset. Whether the same approach suits other index families is not shown by the sources we read.
5. **Not read:** product documentation of vector databases other than pgvector (Elasticsearch, Pinecone and others), ScaNN, locality-sensitive hashing papers, research on filtered ANN search.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the papers. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (latency at a recall target), **scalability** (billions of vectors), **cost** (memory), **availability**, **data freshness**.
- **Style (Ch 13):** **service-based** with a stateless coordinator over stateful index shards.
- **Quanta (Ch 7):** each shard replica is a quantum with its own in-memory state; the index builder is separate and batch.
- **Trade-off (First Law, Ch 1):** **recall vs latency vs memory.** You cannot maximise all three; the index family and its parameters pick a point.
- **ADR sketch (Ch 19):** *"We will use a compressed graph index on SSD-backed shards with a small in-memory index for fresh writes. We accept periodic rebuilds and a second index to search in exchange for lower memory cost."*
- Plain English: a map of shortcuts in a very big library, rebuilt on a schedule.

---

## Interview questions to practice

1. Why can't we just compare a query against every vector?
2. How does HNSW work, and what do M and ef control?
3. What does product quantization do, and what does it cost?
4. How would you serve a billion vectors? When do you shard and when do you use SSD?
5. How would you support filters like "category = shoes and price < 50"?
6. How would you make new items searchable within seconds?
7. You change the embedding model. What happens?
8. How do you measure whether the index is good enough?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: vector count and dimensions, latency and recall targets, filters, freshness, model changes.
2. Estimate: raw bytes, compressed bytes, graph overhead, shards and replicas, queries per second.
3. API: upsert, delete, query with filter and k.
4. Design: embedding service, coordinator, shards with ANN index, fresh-writes index, builder, object storage.
5. Deep dive: choice of index family and parameters; filtering; freshness.
6. Failure and scale: slow shard, recall drift, memory pressure, re-indexing.

**If it grows 10×**
- Memory dominates cost: compress vectors, move full vectors to SSD, keep only compressed codes in RAM.
- Latency tail grows with shard count: use fewer, larger shards where possible, hedged requests, and partitioning by tenant or category.
- Rebuild time grows: build per-segment and merge, as DiskANN merges per-cluster graphs.

**Answer outlines** (try the questions above first)

<details><summary>How does HNSW work?</summary>

A stack of proximity graphs: sparse top layers with long hops, a dense bottom layer with all elements. A search enters at the top, greedily moves to the neighbour closest to the query, drops a layer when it cannot improve, and at the bottom explores a candidate list of size ef. Larger M and ef raise recall and cost memory and time.

</details>

<details><summary>How do you support filters?</summary>

Options: check the predicate while traversing, post-filter with over-fetching, or partition by the filter key. Strongly selective filters break post-filtering, so measure recall with filters on, not just without.

</details>

<details><summary>You change the embedding model. What happens?</summary>

All vectors are incompatible with the new model's query vectors, so you re-embed everything and build a new index next to the old one, compare recall on a labelled set, switch traffic, and keep the old index until you are confident.

</details>

## 📚 Further reading

- The three papers listed under Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) for what embeddings are.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [23 RAG knowledge assistant](23-rag-knowledge-assistant.md), [20 Web crawler and search](20-web-crawler-search.md), [03 Distributed key-value store](03-distributed-kv-store.md) for sharding and replication.

## Sources and provenance

> **Kind:** reference design with real parts. HNSW, Faiss and DiskANN are published designs. How any vector database vendor builds its product is not covered here, so the platform in section 4 is the standard design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (PDF text extracted locally):** Malkov and Yashunin, [*Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs*](https://arxiv.org/pdf/1603.09320) (arXiv 1603.09320) · Douze et al., [*The Faiss library*](https://arxiv.org/pdf/2401.08281) (arXiv 2401.08281, v4 Oct 2025) · Subramanya et al., [*DiskANN: Fast Accurate Billion-point Nearest Neighbor Search on a Single Node*](https://papers.nips.cc/paper_files/paper/2019/file/09853c7fb1d3f8ee67a61b6bf4a7f8e6-Paper.pdf) (NeurIPS 2019) · Singh et al., [*FreshDiskANN: A Fast and Accurate Graph-Based ANN Index for Streaming Similarity Search*](https://arxiv.org/pdf/2105.09613) (2021) · pgvector [README](https://raw.githubusercontent.com/pgvector/pgvector/master/README.md) (read 2026-10-27).
> **Dated material:** the HNSW and DiskANN papers are from 2016–2019; Faiss and the field have moved on.
> **Not read:** other vector database documentation, ScaNN, filtered-ANN papers, and benchmarks such as ANN-Benchmarks.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the HNSW paper: multi-layer proximity graphs, random maximum layer with exponentially decaying probability, logarithmic complexity scaling, skip list analogy, neighbour-selection heuristic, M range 5–48 and memory proportional to M, efConstruction guidance (recall near 1 during construction). No deletion procedure found.
- Verified in the Faiss paper: scope statement (not a service or database), trade-off axes, IVF and nprobe, metadata and filtered-search limits, index updates by id, degradation when the distribution changes.
- Verified in the DiskANN paper: abstract figures (64 GB RAM, SSD, over 5,000 QPS, under 3 ms, 95%+ 1-recall@1, 5–10× more points per node), the compression-based class at around 0.5 1-recall@1, the 100M-vector NSG footprint of about 75 GB (assuming degree 50), the Taobao sharding example as cited, PQ in memory with graph and full vectors on SSD, BeamSearch with W of 4 or 8, the SSD engineering target, k-means overlapping clusters merged by edge union.
- Verified in FreshDiskANN: the static-index problem statement, lazy deletion with a DeleteList and batch consolidation, long-term and short-term index design with StreamingMerge, the reported throughput, latency, DRAM and recall figures.
- Verified in the pgvector README: post-index filtering and the 10% / ef_search 40 / 4 rows example, iterative scans from 0.8.0, partial indexes and partitioning.
- Labelled industry pattern, not sourced: sharding and coordinator design, replicas, the combined filtering strategy list, re-indexing, monitoring, capacity arithmetic.
- Not claimed: behaviour of any named vector database other than the pgvector documentation points above.
