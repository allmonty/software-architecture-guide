# 06 — File Sync (Dropbox)

*A documented real system. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Dropbox splits files into 4 MB blocks identified by SHA-256 and uploads only blocks the server lacks. Content lives in Magic Pocket, an in-house immutable block store separate from the Edgestore metadata store. The client's Nucleus sync engine keeps three trees (remote, local, synced) and plans operations to converge them, tested with deterministic simulation.

**Key numbers**
- Blocks up to 4 MB, SHA-256 `[CONFIRMED]`.
- Magic Pocket cells of about 50 PB, every block in at least two zones `[CONFIRMED]`.
- Streaming sync: up to 2× faster multi-client sync `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Content-addressed blocks | Skip blocks already stored, resumable uploads | A fixed boundary shifts if bytes are inserted |
| Blocks separate from metadata | Different workloads scale independently | Two systems to keep consistent via commit order |
| Three-tree client sync | Tells which side changed | A complex client, hence the simulation testing |

**Common mistakes**
- Calling it deduplication across users: the posts only describe 'need blocks'.
- Assuming Dropbox still runs on S3 for user content.
- Treating a timeout as failure and re-uploading, instead of retrying the same commit.


---

## 🧒 Non-technical explanation

Dropbox is a **shared filing cabinet that follows you around**. You keep a copy of the cabinet on every device, and a **night clerk** makes sure all the copies end up identical.

The clerk works smartly:
- Each file is torn into **fixed-size pages** and every page gets a **fingerprint**. A file is just a list of fingerprints.
- Before you upload anything the clerk asks the warehouse "which of these fingerprints do you **not** already have?" and you only send those pages. Rename a file or copy it, and almost nothing moves.
- The clerk keeps **three notes** — what the cloud looks like, what your disk looks like, and what they both looked like the **last time they agreed** — so when two copies differ, they can tell which side actually changed.

---

## TL;DR for engineers

- **Content-addressed blocks:** every file is split into blocks of up to **4 MB**, each hashed with **SHA-256**. The file's **blocklist** (the list of hashes) identifies its contents `[CONFIRMED]`.
- **Upload protocol:** the client commits a blocklist. The server replies "need blocks" for the missing ones. The client uploads only those straight to a block server, then commits again `[CONFIRMED]`. Existing blocks are never re-sent.
- **Content store = Magic Pocket:** an in-house, multi-exabyte immutable block store, with a separate **metadata** system. Blocks are keyed by hash, grouped into 1 GB buckets, and **erasure coded** `[CONFIRMED]`.
- **Metadata store = Edgestore:** a sharded MySQL-based store with entities and associations, strong consistency by default, and a read-heavy cache layer `[CONFIRMED]`.
- **Client = Nucleus:** a Rust sync engine with **three trees** (Remote, Local, Synced) and a **planner** that outputs operations to converge them. Tested with deterministic randomized simulation `[CONFIRMED]`.
- **Streaming sync** lets a downloading client start fetching blocks of a file before the uploader has committed it, cutting multi-client sync time `[CONFIRMED]`.

---

## 1. Requirements (design framing)

**Functional:** keep a folder identical across many devices · efficient upload and download of large files · sharing · version history · offline edits that merge on reconnect.

**Non-functional:** **durability above all** (Dropbox's stated design target: annual durability over 99.9999999999% and availability over 99.99% `[CONFIRMED]`, "Scaling to exabytes and beyond") · low sync latency · **bandwidth efficiency** · never lose or silently overwrite a user's edit · correctness under concurrent edits from several devices.

---

## 2. Blocks, blocklists and the upload protocol `[CONFIRMED]`

From *Streaming File Synchronization*:
- "Every file in Dropbox is partitioned into **4MB blocks**, with the final block potentially being smaller." Blocks are hashed with **SHA-256**. A file is uniquely identified by its **blocklist**.
- Upload protocol before streaming sync: (1) the client tries to **commit** the blocklist. If blocks are missing the call returns **"need blocks"** listing them. (2) The client uploads those blocks **directly to a blockserver**. (3) The client **commits again** and the file is recorded.

What this buys you (our analysis, `[INDUSTRY PATTERN]`):
- **Dedup within a store:** the post describes the "need blocks" mechanism but does not use the word "deduplication", so we state it as a consequence, not as a Dropbox claim: blocks already in the store need not be uploaded again.
- **Resumable and parallel:** blocks are independent, so a failed upload resumes per block, and blocks can go in parallel.
- **Cheap edits:** change one region of a large file and only the changed blocks differ in the blocklist. (The post does not discuss delta encoding, so treat this as inference from fixed-size blocks.)

### Streaming sync `[CONFIRMED]`

Before it, "the entire file must be uploaded to our servers and committed to our databases" before other clients could see it. Streaming sync lets the downloading client prefetch blocks of an uncommitted file from server memcache so it is nearly done when the metadata commit lands. The goal: the downloader should "always be just one blockserver network call behind the uploading client". Dropbox reports "up to 2x" improvement for multi-client sync, and one test went from 89 s to 64 s for a 100 MB file. It applies to large new files only.

---

## 3. Magic Pocket: the content store `[CONFIRMED]`

| Concept | What the posts say |
|---|---|
| **Block** | Encrypted chunk of a file up to 4 MB. **Immutable** once written. For most uses the key is its SHA-256 hash |
| **Bucket** | Blocks are aggregated into "1GB logical storage containers called buckets" |
| **Volume** | One or more buckets replicated onto a set of physical storage nodes (OSDs) |
| **Cell** | A self-contained logical cluster storing "around 50PB of raw data" with a single Master. A cell scales to "around a hundred petabytes" before master overhead bites |
| **Block Index** | Maps hash to cell, bucket and checksum. A "giant sharded MySQL cluster" behind an RPC service layer |
| **Replication Table** | Also MySQL. Maps buckets to volumes and OSDs. Much smaller than the Block Index |
| **Zones** | Server clusters in the western, central and eastern US. **Every block is stored in at least two zones**, and a block is written to a remote zone "within one second of it being uploaded locally" |
| **Repair** | Starts "once an OSD has been offline for 15 minutes" |
| **Erasure coding** | "Erasure coding for nearly all data". Recent data is first replicated, later aggregated and erasure coded. A **Live Coder** service can write straight into erasure-coded volumes (not ideal for latency-sensitive traffic). **The scheme and parameters are not given in the posts we read** |

**History** (from "Scaling to exabytes and beyond", 2016-03-14): Dropbox said "We were an early adopter of Amazon S3", with file content stored on Amazon. It began storing and serving user files exclusively in-house on **2015-02-27**, and reached **over 90%** of user data in-house on **2015-10-07**. Its growth "from our initial double-digit-petabyte prototypes to a multi-exabyte behemoth" took "around 6 months" (Inside the Magic Pocket). Most of Magic Pocket was built by "less than half a dozen people".

**Why separate blocks from metadata?** Blocks are big, immutable and cold-ish: a different workload from small, hot, strongly consistent metadata. That separation is why the Block Index is a lookup *into* storage, not part of the file's metadata record `[INDUSTRY PATTERN]`.

---

## 4. Edgestore: the metadata store `[CONFIRMED]` ((Re)Introducing Edgestore)

- Objects are **Entities** or **Associations** with user-defined attributes. Associations describe relationships between entities. The post's examples are users, teams, folders, email messages and U2F tokens, and it does not name files or namespaces explicitly.
- Stateless **Cores** route requests to the shard that is the master for the data. **Engines** store it. A **caching layer** (partitioned and replicated) speeds the read-heavy workload, with cache invalidation on writes for strong consistency.
- **Strong consistency by default**, eventual consistency on request.
- Scale as stated in that post: "several trillion entries", "millions of queries per second", "5–9s of availability", on "thousands of machines across multiple data centers". These are older figures.
- A later set of Dropbox posts (found in search, not read in full) describes Panda, a key-value layer between Edgestore and sharded MySQL for rebalancing and two-phase commit. We do not use its details here.

---

## 5. The client: Nucleus `[CONFIRMED]`

### Why it was rewritten
The old engine's data model was designed for a world without sharing: "files lacked a stable identifier that would be preserved across moves". Incremental fixes could not change the foundation, and coarse-grained locking gave up parallelism for easier reasoning.

### The three trees (*Testing sync at Dropbox*)
| Tree | Meaning |
|---|---|
| **Remote Tree** | "The latest state of the user's Dropbox in the cloud" |
| **Local Tree** | "The last observed state of the user's Dropbox on disk" |
| **Synced Tree** | "The last known 'fully synced' state between the Remote Tree and Local Tree" |

Sync is complete when all three match. The **planner** takes the three trees and outputs "a series of operations to incrementally converge the trees". Having the Synced Tree as a **common ancestor** is what lets it tell whether the remote, the local side or both changed something, which is the classic three-way-merge idea `[INDUSTRY PATTERN]`.

### Design and testing
- Written in **Rust**, so the type system can encode invariants. Most code runs on a single **Control thread** scheduling futures, with network, hashing and file I/O offloaded to other threads.
- The Control thread is **deterministic** given fixed inputs and scheduling, so it is fuzzed with pseudorandom simulation, and if a sync correctness check fails, "we can always reproduce the bug from the original seed". Dropbox says it runs "millions of scenarios every day".
- **CanopyCheck** tests the planner (generate one tree, perturb it into the other two, run the planner without real I/O, check termination, no panics and correctness, then shrink failures). **Trinity** tests the engine's concurrency, such as a remote deletion clobbering a concurrent local edit.
- Protocol guarantees (*Rewriting the heart…*): server and client agree on the remote filesystem's state before considering a mutation. Shared folders and files have **globally unique identifiers**. Moves are **atomic** regardless of subtree size.

---

## 6. End-to-end flows (interview framing)

**Edit a file on device A, see it on device B** `[INDUSTRY PATTERN]` except where tagged:
1. A's watcher sees the change and the Local Tree updates `[CONFIRMED]` (Nucleus model).
2. A hashes the file into blocks and commits the blocklist `[CONFIRMED]`. The server returns "need blocks" for new ones.
3. A uploads the missing blocks to a blockserver, then commits `[CONFIRMED]`. Metadata in Edgestore now points at the new blocklist.
4. B learns of the change (a notification or long-poll channel is the standard design, but the specific mechanism is not covered in the posts we read), updates its Remote Tree, and the planner produces a download plan `[CONFIRMED]` for the planner part.
5. B fetches the blocks it lacks from the block store. Streaming sync may let it start before A's commit `[CONFIRMED]`.

**Conflicts:** when the planner sees both sides changed the same path, product policy decides. The usual approach is to keep both and rename one as a "conflicted copy". The posts we read do not detail Dropbox's policy, so that is `[INDUSTRY PATTERN]`.

---

## ⚠️ Reviewer notes

1. **"Dedup" is a consequence, not a quoted feature.** The Streaming Sync post describes only "need blocks". Cross-user dedup in particular, or in what scope hashes are shared, was not stated in the posts we read and is not claimed here. (Content-addressed storage also has security implications, so scope is a real design question `[INDUSTRY PATTERN]`.)
2. **Do not say "Dropbox runs on S3".** It did early on, and moved user content to Magic Pocket in 2015 per Dropbox's own post.
3. **Fixed 4 MB blocks are not content-defined chunking.** Inserting a byte at the start of a file shifts every later block boundary in fixed-block schemes, so every following block hash changes. The posts we read describe fixed blocks. Do not credit Dropbox with rolling-hash chunking (as rsync or some backup tools use). This is general knowledge `[INDUSTRY PATTERN]`.
4. **Several figures are from 2015–2020 posts** (Edgestore's "5–9s", Magic Pocket "multi-exabyte", 50 PB cells). They describe those years.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the posts. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **durability/recoverability** (never lose data), **data integrity** (never silently overwrite), **efficiency** (bandwidth), **scalability**, and **testability** (Dropbox's simulation testing is a direct investment here).
- **Style (Ch 13/17):** a **service-based** split into a content plane (block servers, Magic Pocket), a metadata plane (Edgestore) and a **rich client** with its own engine. The client is as much a part of the architecture as any server.
- **Quanta (Ch 7):** the content store and the metadata store are separate quanta with different needs: immutable and cold-ish versus small, hot and strongly consistent. Each client's Nucleus is its own quantum that can work offline.
- **Trade-off (First Law, Ch 1):** **client complexity vs server simplicity.** Pushing planning into the client reduces server load and works offline, but means correctness depends on code running on millions of machines, which is why Dropbox invested in deterministic simulation.
- **ADR sketch (Ch 19):** *"We will store immutable, hash-addressed blocks separately from strongly consistent metadata, and sync with a three-tree planner on the client. We accept a complex client in exchange for offline support and cheap uploads."*
- Plain English: the pages and the index cards live in different rooms, and the night clerk in each office decides what to carry between them.

---

## Interview questions to practice

1. Why split a file into fixed-size blocks? What goes wrong when someone inserts a byte at the beginning of a large file? How would content-defined chunking help?
2. Walk through "need blocks". Why is the final metadata commit separate from the block upload?
3. Two devices edit the same file offline. What does the synced tree tell you, and what should the system do?
4. Why keep block metadata (hash → location) separate from file metadata?
5. How would you notify other devices of a change without polling?
6. How would you test a sync engine whose bugs only appear under rare interleavings?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: file sizes, sharing, offline edits, conflicts.
2. Estimate: files, edits per day, bandwidth.
3. API: commit blocklist, upload blocks, list changes.
4. Design: block servers, metadata store, notification, client engine.
5. Deep dive: blocklists, three trees, conflicts.
6. Failure and scale: dropped uploads, concurrent edits, notification fan-out.

**If it grows 10×**
- Metadata becomes the bottleneck: shard and cache it.
- Large files: stream blocks to other devices before the commit.
- Storage efficiency: erasure code cold blocks.

**Answer outlines** (try the questions above first)

<details><summary>Why fixed-size blocks, and what goes wrong when a byte is inserted at the front?</summary>

Fixed blocks are simple and resumable, but inserting a byte shifts every later boundary, so every later block hash changes. Content-defined chunking avoids that.

</details>

<details><summary>Why is the final metadata commit separate from the block upload?</summary>

Blocks can arrive in any order and be retried. The commit atomically makes the new version visible only when all its blocks are present.

</details>

<details><summary>Two devices edit offline. What does the synced tree tell you?</summary>

It is the last agreed state, so comparing it with each side shows who changed what. If both changed the same path you need a conflict policy such as keeping both.

</details>

## 📚 Further reading

- The Dropbox posts listed at the top. Also [Alki, cold metadata](https://dropbox.tech/infrastructure/alki--or-how-we-learned-to-stop-worrying-and-love-cold-metadata) and [Cross-shard transactions at 10M requests per second](https://dropbox.tech/infrastructure/cross-shard-transactions-at-10-million-requests-per-second) (appear in search, not read here).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary background on caching, replication and consistency).
- Related in this repo: [05 Object storage](05-object-storage-s3.md) for erasure coding, and [`neokim-post/11` Google Docs](https://github.com/allmonty/study/blob/main/architecture/neokim-post/11-how-google-docs-works.md) for real-time merge.

## Sources and provenance

> **Kind:** real-system, partly public. Dropbox's engineering blog documents the block storage layer (Magic Pocket), the block/blocklist upload protocol, the Nucleus sync engine and the Edgestore metadata store. It does **not** publish the full client/server change-notification protocol, so that part is a design sketch `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (all Dropbox Tech Blog):** [Inside the Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket) · [Scaling to exabytes and beyond](https://dropbox.tech/infrastructure/magic-pocket-infrastructure) (2016-03-14) · [Improving storage efficiency in Magic Pocket](https://dropbox.tech/infrastructure/improving-storage-efficiency-in-magic-pocket-our-immutable-blob-store) · [Streaming File Synchronization](https://dropbox.tech/infrastructure/streaming-file-synchronization) · [Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine) · [Testing sync at Dropbox](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine) · [(Re)Introducing Edgestore](https://dropbox.tech/infrastructure/reintroducing-edgestore).
> **Dated material:** the blog posts span years. Scale figures are as of each post, not current.
> **Tags:** `[CONFIRMED]` stated by a Dropbox post · `[INDUSTRY PATTERN]` standard practice, not stated for Dropbox · `[SPECULATIVE]` plausible.

---
## ✅ Verification log

*Fact-check, 2026-10-27, each post fetched and read. Quotes in this file match the fetched text.* Claims we could not confirm were dropped or downgraded rather than kept, as listed below.
- Verified: Magic Pocket "multi-exabyte", growth in "around 6 months", 4 MB encrypted immutable blocks keyed by SHA-256, 1 GB buckets, volumes, ~50 PB cells with a single Master (~100 PB limit), OSD capacity, replicate-then-erasure-code, Block Index and Replication Table in MySQL, two-zone minimum with remote write "within one second", 15-minute repair trigger, "less than half a dozen people".
- Verified: 2015-02-27 first in-house cutover, 2015-10-07 90% milestone, "early adopter of Amazon S3", durability/availability design targets (2016-03-14 post).
- Verified: 4 MB blocks, SHA-256, blocklist, "need blocks" protocol, streaming-sync behaviour, "up to 2x", the 89 s → 64 s test.
- Verified: Nucleus reasons for the rewrite, the Rust/Control-thread design, deterministic simulation with seeds, "millions of scenarios every day", the three trees with their quoted definitions, the planner, CanopyCheck's steps, Trinity's purpose, protocol guarantees on unique IDs and atomic moves.
- Verified: Edgestore entities/associations, Cores/Engines/caching, strong consistency by default, "several trillion entries", "millions of queries per second", "5–9s".
- Removed: the "S3 migration" and "LRC" and "2x→1.5x" ideas we had expected to find. The posts we read do not state them, so we do not either. Erasure-coding parameters are marked as not public.
- Removed: any detail of Dropbox's public HTTP API (cursors, long-poll). Our fetch of the API docs returned only navigation, so nothing from it is used.
- Not read in full: Panda, Alki, cross-shard transactions (seen only in search snippets), so used only as pointers.
- Scoped: "dedup", conflict handling, device notification and the end-to-end flow are labelled `[INDUSTRY PATTERN]` because no Dropbox post we read states them.
