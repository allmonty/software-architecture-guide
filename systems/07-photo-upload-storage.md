# 07 — Photo Upload & Storage

*A documented real system. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Storing billions of photos is a metadata problem as much as a data problem. Facebook's Haystack packed many photos into huge files with an in-memory index so a read costs about one disk seek, and f4 later moved cooling photos to Reed-Solomon (10,4) storage to cut the effective replication factor from 3.6 to 2.1. Modern uploads go straight to blob storage with a short-lived pre-signed URL.

**Key numbers**
- Haystack: about 10 bytes of memory per photo versus 536 bytes for an xfs inode `[CONFIRMED]`.
- f4: effective replication 3.6 → 2.8 → 2.1 `[CONFIRMED]`.
- Facebook stored over 400 billion photos in February 2014 `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Many photos per big file | Keeps all file metadata in memory | Append-only, so deletes need compaction |
| Hot/warm tiers by age | Warm photos can use cheaper storage | A router tier and migration machinery |
| Direct-to-blob upload | App servers stay out of the data path | Pre-signed URLs are bearer tokens |

**Common mistakes**
- Presenting Haystack as how Instagram stores photos.
- Proposing 'S3 plus CDN' without saying why the metadata and replication pressures do or do not apply.
- Using long-lived or guessable pre-signed upload URLs.


---

## 🧒 Non-technical explanation

A photo service is like a **huge photo lab with a viewing window**.

- You hand your photo to the lab through a **side door** (a one-time pass lets you walk it straight to the archive without bothering the front desk).
- The lab makes **several print sizes**: thumbnail, medium, large.
- A **display wall at the street** (the CDN) shows the famous photos. The **archive** in the back holds everything else.
- The trick that made Facebook's archive work: instead of one **folder per photo** (and a clerk who has to look up every folder before fetching), they bound photos together into **giant albums** and kept a tiny **index card per photo in the clerk's head**, so fetching a photo takes one trip to the shelf.
- Photos are **hot when new and cold when old**. The back room moves old ones to cheaper storage that keeps the same safety with fewer copies.

---

## TL;DR for engineers

- **Photos are immutable blobs:** created once, read many times, deleted rarely `[CONFIRMED]` (f4).
- **The expensive part of billions of small files is metadata, not data.** Haystack's fix: pack many photos into **~100 GB volume files** and keep a compact **in-memory index** (offset and size per photo), so a read costs about one disk operation `[CONFIRMED]` (Haystack).
- **Three components:** Directory (logical→physical volume mapping, write placement), Cache (an internal CDN), Store (the volume files). The external CDN absorbs the popular head, Haystack the long tail `[CONFIRMED]`.
- **Temperature matters.** Request rate falls with age, so new photos live in hot storage (Haystack, triple replicated) and are later moved to **f4**, which uses **Reed-Solomon (10,4)** erasure coding and XOR across datacenters to cut the effective replication factor from **3.6 to 2.8, then 2.1** `[CONFIRMED]`.
- **Upload (modern pattern):** the client uploads **straight to blob storage** with a short-lived pre-signed URL, so large bytes bypass app servers. Derivatives (thumbnails, sizes) are produced **asynchronously** `[INDUSTRY PATTERN]` (the presigned-URL mechanism is `[CONFIRMED]` in AWS docs).

---

## 1. Requirements (design framing)

**Functional:** upload photos (single and albums, large files, flaky mobile networks) · view at several sizes · delete · basic metadata (owner, time, privacy) · fast global viewing.

**Non-functional:** **durability** (a lost photo is a user-visible loss) · low read latency, especially for recent photos · **cost per stored photo** at billions of objects · availability across disk, host, rack and datacenter failures · scalable writes (one billion photos a week in Haystack's era).

**Scale as stated in the papers:** Haystack (2010): "over 260 billion images, which translates to over 20 petabytes of data", with users uploading "one billion new photos (~60 terabytes) each week". f4 (2014): "As of February 2014, Facebook stored over 400 billion photos", and f4 held "over 65PBs of logical BLOBs" `[CONFIRMED]`.

---

## 2. Upload path

### Modern pattern: direct-to-storage with a pre-signed URL `[INDUSTRY PATTERN]`

1. Client asks the API to start an upload (`POST /photos` with size and type). The API creates a photo record in `pending` state and returns a **pre-signed URL**.
2. Client `PUT`s the bytes directly to blob storage. Large files use multipart/resumable upload.
3. Blob storage emits an event (or the client calls "complete"). A worker validates the file (type, size, malware scan), writes the **derivatives** and flips the photo to `ready`.

Why it works, per AWS docs `[CONFIRMED]`: a presigned URL grants "time-limited access to objects" and "allows an upload without requiring another party to have AWS security credentials". It names a bucket, key, HTTP method and expiry, and may be used multiple times until it expires. With the SDK, expiry can be up to **7 days**, but with temporary credentials the URL expires when they do. AWS calls presigned URLs "bearer tokens", so treat them as secrets: keep expiry short, scope the key, and verify integrity with checksums. Note also: if the key exists, "Amazon S3 replaces the existing object", so generate unique keys per upload.

Design choices to say out loud `[INDUSTRY PATTERN]`: keep app servers out of the data path · make derivative generation **idempotent** (same input → same outputs, safe to retry) · store the **original** untouched and derive from it · strip or normalise metadata (e.g. location EXIF) for privacy.

### What Facebook actually did in Haystack (2010) `[CONFIRMED]`

The upload went **through a web server**: the user sends the data to a web server, which requests a **write-enabled logical volume** from the Directory, assigns a **unique photo id**, and writes it to **each physical volume** mapped to that logical volume. The web server scales each photo to **four sizes**, stored as separate needles with the same key and different "alternate keys". Uploads of albums are **batched**, because disks are better at large sequential writes `[CONFIRMED]`.

This contrasts with the modern pattern above: Haystack's design predates presigned-URL-style uploads, and its web tier did the scaling. Both are valid, in different eras.

---

## 3. Haystack: why the obvious design was slow, and the fix

### The NFS design and its problem `[CONFIRMED]`
Each photo was a separate file on NAS appliances over NFS. Reading one needed several disk operations just for metadata ("one (or typically more) to translate the filename to an inode number, another to read the inode from disk, and a final one to read the file itself"). Putting thousands of files per directory was inefficient. Hundreds per directory still needed about three operations per image. A CDN alone did not fix it because the long tail of less-popular photos typically misses the CDN, and caching all of them is not cost-effective.

### The Haystack design `[CONFIRMED]`
- **Store:** machines with physical volumes, each "a very large file (100 GB)", grouped across machines into **logical volumes**. A write to a logical volume goes to all its physical volumes, which protects against drive failures, controller bugs and so on.
- **Needle:** one stored photo inside a volume: header magic number, cookie, 64-bit key (photo id), 32-bit alternate key (the size type), flags (deleted), size, data, footer magic number, data checksum, padding to 8 bytes.
- **In-memory index:** per volume, maps (key, alternate key) → flags, size, offset. A read is: look up in memory, seek once, read the needle, verify cookie and checksum.
- **Append-only:** writes append a needle synchronously and update the in-memory map. An "overwrite" (e.g. a rotation) appends a new needle with the same key. The latest version is the one at the highest offset.
- **Delete:** set the deleted flag in memory and synchronously in the needle. Space is reclaimed later by **compaction**, which copies live needles to a new file and atomically swaps. About **25%** of photos get deleted over a year.
- **Index file:** an asynchronously written checkpoint of the in-memory map to speed restarts. Needles without index records ("orphans") are repaired on restart.
- **Memory cost:** about **10 bytes of main memory per photo**, 40 bytes for the four scaled sizes of one image, compared to 536 bytes for a Linux `xfs_inode_t` `[CONFIRMED]`.
- **Directory:** logical→physical mapping, write/read load balancing, decides CDN vs Cache, marks volumes read-only. Stored in a replicated database accessed via PHP with memcache.
- **Cache:** an internal distributed hash table keyed by photo id that shelters write-enabled Store machines. It caches a photo only if the request comes **directly from a user** (not from the CDN) and the photo is fetched from a **write-enabled** machine.
- **The URL** encodes the path: `http://<CDN>/<Cache>/<Machine id>/<Logical volume, Photo>`. The **cookie**, a random number assigned by the Directory at upload and embedded in the URL, prevents guessing valid photo URLs.
- **Failure handling:** a background **pitchfork** task health-checks Store machines and marks volumes on failing machines read-only. A rare **bulk sync** from a replica resets a machine, taking "hours" because the data volume far exceeds NIC speed.

---

## 4. f4: moving warm photos to cheaper storage `[CONFIRMED]` (OSDI '14)

**Insight:** age predicts temperature. "The request rate for week-old BLOBs is an order of magnitude lower than for less-than-a-day old content for eight of nine examined types", and for six of the nine types it drops 100× in under 60 days. Hot-to-warm delimiter: about a month for most types, **three months for Photos**, and Profile Photos are not moved to warm storage at all. Haystack triple-replicates, which "results in over provisioning from a throughput perspective" for warm data.

**Overall architecture:** a caching stack, a **transformer tier** (compute-heavy transformations, scaled independently), a **router tier** (hides the storage system and enables migration between them) and hot storage (Haystack). New BLOBs are aggregated into volumes in Haystack until their request and delete rates cool, then they migrate to f4.

**Effective replication factor** = physical size ÷ logical size. With 3 replicas and RAID-6 over 12 disks per node it is **3.6**.

| Setup | Effective replication factor | How |
|---|---|---|
| Haystack | 3.6 | 3 replicas × RAID-6 on 12 disks |
| f4, single cell | 1.4 | Reed-Solomon **(10,4)**: 10 data blocks + 4 parity. Blocks laid out on different racks |
| f4, 2 datacenters | 2.8 | Cell replicated in a second datacenter |
| f4, geo XOR (being deployed at the time) | **2.1** | XOR of buddy blocks from volumes in two datacenters is stored in a third. (1.4×2 + 1.4)/2 = 2.1 |

- A cell sits in one datacenter: **14 racks of 15 hosts with 30 × 4 TB drives per host** (at the time). It handles only **locked** (read-only) volumes, so it supports reads and deletes only.
- **Deletes** without compaction: each BLOB is **encrypted** with a per-BLOB key kept in a separate key store. Deleting the key makes the BLOB unreadable. This also removes Haystack's journal file.
- Index files are **triple-replicated** (too small to be worth encoding). Decryption happens on the **router tier** so it can scale independently of storage.
- Components of a cell: storage nodes (Index API and File API), name nodes (primary-backup), **backoff nodes** that reconstruct reads when blocks are missing, rebuilder nodes, and coordinator nodes.
- **Trade-off:** erasure coding gives lower storage overhead for "increased rebuild and recovery times under failure and lower maximum read throughput".

---

## 5. Serving photos `[INDUSTRY PATTERN]` unless marked

- **Immutable URLs:** include a content hash or version so CDN caching is safe forever, and a replaced photo gets a new URL. (Haystack's append-only rule, where a changed photo is a new needle with the same key, is the storage analogue.)
- **Sizes:** generate a fixed set of derivatives (Haystack used four) rather than resizing on every request. Alternatively resize on demand and cache. The trade is storage vs CPU and latency.
- **CDN in front:** serves the popular head. The origin only sees misses, so provision it for the long tail `[CONFIRMED]` (Haystack's motivation).
- **Metadata** (owner, privacy, album) lives in a separate store from the bytes. In f4's description, the web tier stores a BLOB **handle** in the graph store (Tao) alongside the other relationships, and builds URLs from it at read time `[CONFIRMED]`.
- **Privacy on delete:** deleting an encryption key (f4) is a way to make bytes unreadable immediately even when physical removal is lazy.

---

## ⚠️ Reviewer notes

1. **Do not present Haystack as "how Instagram stores photos".** The papers are about Facebook, and Instagram's own architecture is not described in the papers we read. Many interview answers blur this.
2. **"S3 + CDN" is a fine answer, but it hides the real lesson.** Haystack and f4 exist because per-object metadata and replication overhead dominate at billions of small objects. If you propose S3, be ready to say why the same pressures do or do not apply to you.
3. **Presigned URLs are bearer tokens.** Leaking one grants access until it expires. Short expiry and unique keys matter.
4. **Numbers age.** The 2010 and 2014 figures (260 B images, 400 B photos, 65 PB in f4, 3.6→2.1) are what the authors reported then. The XOR geo-replication was "being deployed" when f4 was published.
5. **f4's "2.1" is an effective replication factor, not durability.** It says how much raw space is used per logical byte.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the papers. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **durability/recoverability**, **cost efficiency**, **performance** (single-seek reads, CDN), **scalability**, **security** (unguessable URLs, key-based deletion).
- **Style (Ch 13/17):** **service-based** at the macro level (web tier, Directory, Cache, Store, later router, transformer and cold tier). Within the store it is a **shared-nothing** cluster of cells.
- **Quanta (Ch 7):** hot storage (Haystack) and warm storage (f4) are **separate quanta with different characteristics**: one tuned for IOPS, the other for storage efficiency. The router tier is the seam that lets blobs migrate between them.
- **Trade-off (First Law, Ch 1):** **cost vs throughput/latency.** Erasure coding saves bytes but costs rebuild time and read throughput, so it is only applied once the data is cool.
- **ADR sketch (Ch 19):** *"We will keep new photos in triple-replicated hot storage and migrate them to erasure-coded warm storage after about three months. We accept slower rebuilds and lower per-BLOB throughput on old photos."*
- Plain English: keep the new prints on the front counter, and move the old ones to the archive, where you keep fewer copies but still cover the same risks.

---

## Interview questions to practice

1. Why is one file per photo a bad idea at billions of photos? What does Haystack change?
2. Design the upload path for 20 MB photos on flaky mobile networks. When do you create the DB record, and what happens if the client never completes?
3. How do you serve four sizes of each photo? Pre-generate, or resize on demand? Defend your choice.
4. How would you delete a photo promptly when physical space reclamation is lazy?
5. Why would you migrate old photos to erasure-coded storage? What do you give up?
6. How do you stop people from guessing photo URLs?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: sizes, privacy, derivatives, retention.
2. Estimate: photos per day, sizes, storage growth.
3. API: start upload, complete, get photo URL.
4. Design: upload path, blob store, derivative workers, CDN.
5. Deep dive: Haystack needles and f4 erasure coding.
6. Failure and scale: abandoned uploads, hot photos, deletes.

**If it grows 10×**
- Per-photo files break first: pack photos and index in memory.
- Storage cost dominates: tier by age and erasure code warm data.
- Origin load: size the CDN for the long tail.

**Answer outlines** (try the questions above first)

<details><summary>Why is one file per photo a bad idea at billions of photos?</summary>

Reading a photo needed several disk operations for metadata alone. Packing photos into big files with an in-memory index cut a read to about one seek.

</details>

<details><summary>Design the upload path for 20 MB photos on flaky networks.</summary>

Create a pending record, hand out a short-lived pre-signed multipart URL, let the client resume per part, then process asynchronously. A sweeper cleans up uploads that never complete.

</details>

<details><summary>How do you delete promptly when space reclamation is lazy?</summary>

f4 encrypts each blob with its own key and deletes the key, which makes the data unreadable immediately.

</details>

## 📚 Further reading

- [Haystack, OSDI '10](https://www.usenix.org/legacy/event/osdi10/tech/full_papers/Beaver.pdf) · [f4, OSDI '14](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-muralidhar.pdf)
- [AWS: presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [System Design Primer: scaling to millions of users, CDN and object storage topics](https://github.com/donnemartin/system-design-primer) (secondary)
- Related in this repo: [05 Object storage](05-object-storage-s3.md) (erasure coding and durability), [06 File sync](06-file-sync-dropbox.md) (content-addressed blocks), [`neokim-post/03` YouTube](https://github.com/allmonty/study/blob/main/architecture/neokim-post/03-how-youtube-works.md) (a similar upload-then-transcode flow).

## Sources and provenance

> **Kind:** real-system for the storage half, reference design for the upload half. Facebook's **Haystack** (OSDI 2010) and **f4** (OSDI 2014) papers describe how a very large photo store was actually built. How a modern app accepts uploads (pre-signed direct upload, derivative pipeline) is a standard pattern, documented by object-store vendors but not by a single "photo app" company, so it is tagged `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 in full text:** [Beaver et al., *Finding a needle in Haystack: Facebook's photo storage*, OSDI '10](https://www.usenix.org/legacy/event/osdi10/tech/full_papers/Beaver.pdf) · [Muralidhar et al., *f4: Facebook's Warm BLOB Storage System*, OSDI '14](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-muralidhar.pdf) · [AWS docs: presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
> **Dated material:** the papers are from 2010 and 2014. The figures describe those years, and Facebook's current system has evolved since. We did not read newer Facebook or Instagram posts for this note.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice, not stated for a named company · `[SPECULATIVE]` plausible.

---
## ✅ Verification log

*Fact-check, 2026-10-27, from the extracted text of both papers and the AWS docs page.* Verified, with notes on what was dropped or scoped:
- Verified in the Haystack paper: 260 billion images / 20 PB / one billion (~60 TB) photos per week; NFS design metadata-read costs; three components; 100 GB physical volumes, logical volumes written to all physical volumes; needle fields; in-memory mapping and single-seek read; cookie assigned by the Directory; append-only writes and highest-offset-wins; delete flag and compaction; ~25% deleted per year; index file with orphans; pitchfork; bulk-sync recovery in hours; ~10 bytes of memory per photo, 40 bytes per four sizes vs 536 bytes for `xfs_inode_t`; four sizes per upload; batch uploads; Cache admission rules; URL layout; Directory's four jobs.
- Verified in the f4 paper: 400 billion photos (Feb 2014), 65 PB, 3.6 → 2.8 → 2.1; the 3.6 derivation; age/temperature findings and the "order of magnitude" quote; three-month hot/warm threshold for Photos and one month for most other types; Reed-Solomon (10,4), XOR geo-coding and the (1.4×2+1.4)/2 arithmetic (re-derived by hand); cell geometry; locked volumes only; per-BLOB encryption with key deletion; triple-replicated index files; router/transformer tiers; BLOB handle stored in Tao.
- Verified in AWS docs: presigned URL semantics, 7-day SDK maximum, temporary-credential expiry, "bearer tokens", overwrite-on-same-key, checksum support.
- Dropped: any claim about Instagram or Pinterest storage. We did not read their posts, so none is made.
- Scoped: "Haystack uploads go through a web server" describes the 2010 paper. We do not claim it for any current system.
- Scoped: the modern upload pipeline and image-serving advice are `[INDUSTRY PATTERN]`, not tied to a company.
- Not verified: Facebook's current architecture, and what became of the "proactively push new photos into the Cache" optimization the Haystack paper says it planned.
- Quote audit (2026-10-27): restored an omitted phrase in the Haystack inode quote ("one (or typically more) …").
