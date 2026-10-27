# 09 — Discord

*A documented real system. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Discord's real-time core is Elixir: a session process per connected user and a process per guild, with the guild publishing events to every connected session. Large guilds made fan-out the bottleneck, which Manifold, Rust components and a coalescing data-services layer address. Messages moved from Cassandra to ScyllaDB, and voice runs on separate servers with an SFU.

**Key numbers**
- Nearly 5 million concurrent users in 2017; up to 500,000 sessions per Erlang VM `[CONFIRMED]`.
- Cassandra 177 nodes → ScyllaDB 72 nodes; p99 reads 40–125 ms → ~15 ms `[CONFIRMED]` (2023).
- 2.6 million+ concurrent voice users on 850+ voice servers (2018) `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| A process per guild | Simple, consistent fan-out | A single process is a bottleneck for large guilds |
| Request coalescing in data services | One query for many identical reads | An extra hop and consistent-hash routing |
| Client-server voice with an SFU | Cheaper than peer-to-peer at scale, hides IPs | Server fleet and regional capacity |

**Common mistakes**
- Quoting '11 million concurrent users' as a stated figure from the 2019 post body.
- Stating a literal `(channel_id, bucket)` key when the post says 'channel plus a bucket'.
- Applying 2017 numbers to today's system.


---

## 🧒 Non-technical explanation

Discord is a **city of clubhouses** (servers, called *guilds*). Each clubhouse has a **receptionist** (a guild process) who knows who is inside. When someone says something, the receptionist shouts it to everyone currently in the room. Each member also has their own **personal assistant** (a session) who holds their phone line and relays what the receptionist shouts.

Three problems dominate:
1. **Big rooms:** if 30,000 people are inside, shouting to all of them takes a long time, so the receptionist must be smart about how it delivers.
2. **A huge filing room:** every message ever sent has to be filed so you can scroll back years. The filing system must stay fast even when everyone asks for the same page.
3. **Voice calls:** audio can't go through the same office as text. It uses separate **switchboards** close to the callers.

---

## TL;DR for engineers

- **Real-time layer in Elixir/Erlang:** each user connects over a **WebSocket** and gets a **session process**. Each guild is a **guild process** on some node. Sessions subscribe to guilds, and a guild publishes events to every connected session `[CONFIRMED]` (2017 post).
- **Fan-out was the bottleneck.** A single `send/2` took 30–70 µs, so publishing to a 30,000-user guild could take **900 ms to 2.1 s**. Discord's **Manifold** library batches sends per remote node and partitions work across cores `[CONFIRMED]`.
- **Rust where Elixir/Go hurt:** Rust NIFs for the member list (**SortedSet**), and Rust rewrites of services such as **Read States** (Go's GC caused ~2-minute latency spikes) `[CONFIRMED]`.
- **Message storage:** partitioned by **channel + time bucket**, IDs are **Snowflakes** (time-sortable). Moved **Cassandra (177 nodes) → ScyllaDB (72 nodes)** in 2022, behind Rust **data services** that **coalesce identical concurrent requests** `[CONFIRMED]` (2023 post).
- **Voice:** a separate fleet of voice servers, each with an Elixir **signaling** part and a C++ **SFU**, client-server (not peer-to-peer), audio over UDP `[CONFIRMED]` (2018 post).

---

## 1. Real-time core: sessions and guilds `[CONFIRMED]` (2017 post)

- A user opens a **WebSocket** to Discord. That starts a **session** (an Elixir GenServer) which talks to remote Erlang nodes hosting **guilds** (also GenServers).
- Discord is "mostly pub/sub": when something happens in a guild, it is published to **every session connected to that guild**. A guild also publishes presence updates, e.g. when a user comes online.
- An average user is in about **5 guilds**. Nearly **5 million concurrent users** and "millions of events per second" at the time, with up to **500,000 live sessions per Erlang VM** handling sessions.
- Request/reply between Erlang processes costs about 12 µs.

### Big guilds hurt `[CONFIRMED]`
Large servers reached **30,000 concurrent users** (the post cites a subreddit server). At peak, guild processes fell behind on their message queues and engineers had to manually intervene and turn off features that generated messages to cope (paraphrase). The cause was fan-out cost: one `send/2` took **30–70 µs**, and the post says publishing an event from a large guild "could take anywhere from 900ms to 2.1s". Applying that range to the 30,000-user example is our inference (30,000 × 30–70 µs ≈ 0.9–2.1 s), not a statement in the post.

### Manifold `[CONFIRMED]`
Manifold distributes the cost of sending. It **groups recipient PIDs by remote node**, sends one message per node to a `Manifold.Partitioner`, which hashes PIDs (`:erlang.phash2/2`), groups them by core count and hands them to child workers for local delivery. The sending process calls `send/2` at most once per involved remote node, which preserves message ordering ("linearizability" in the post's words), and cuts inter-node network traffic.

### Other fixes from the same post `[CONFIRMED]`
- **FastGlobal:** a consistent-hash ring lookup copied from ETS cost ~7 µs per read, **17.5 s** in total for a session restart storm. Storing the ring as constant module data (a mochiglobal-style trick) brought lookups to 0.3 µs and the total to **750 ms**. Session restarts had taken ~30 s on ring lookups alone.
- **Semaphore:** nearly 5,000,000 sessions hammering ten guild-registry processes caused timeouts, retry pile-ups and cascading outages. Discord chose **not** to use a circuit breaker, because a burst of timeouts could stop all attempts entirely. A counter-based semaphore built on `:ets.update_counter/4` **fails early** when too many requests are outstanding.

---

## 2. Rust for the hot spots `[CONFIRMED]`

### Member list: SortedSet (2019 post)
Discord changed the member list to send updates only for the **visible portion**, which needed a structure for **hundreds of thousands** of entries with many mutations. Elixir's immutable structures meant adding one member to a 100,000-member list built a new 100,001-member list.

| Approach tried | Result (from the post) |
|---|---|
| `MapSet` | Ruled out: no ordering guarantee |
| Sorted-list wrapper | ~170,000 µs to append to a 250,000-item list |
| Erlang `ordsets` | ~27,000 µs worst case at 250,000 items |
| Cell-based OrderedSet | ~19,000 µs for insertion at the front, led to a redesign |
| Dynamic OrderedSet | ~4 µs at the start, ~640 µs at the end at 250,000 items. Capped guilds at 250,000 members |
| **Rust NIF SortedSet** | Best 0.61 µs, worst 3.68 µs (5,000 to 1,000,000 items). "Powers every single Discord guild" |

Built with **Rustler**. The post says operations are "well under the 1 millisecond threshold", so the team did not need to handle reductions or yielding. Open-sourced as `sorted_set_nif`.

### Read States: Go → Rust (2020 post)
The **Read States** service tracks which channels and messages each user has read, and is hit on every connect, message send and message read. Go's garbage collector forced a collection at least every 2 minutes, scanning an LRU cache of "tens of millions" of entries, causing "latency and CPU spikes roughly every 2 minutes". Shrinking the cache cut the spikes but raised p99 latency. The Rust version "had no latency spikes", later "beat Go on every single performance metric", and the cache was raised to 8 million read states.

---

## 3. Message storage `[CONFIRMED]` (2023 post, Bo Ingram)

| Stage | What the post says |
|---|---|
| 2017 | "We ran 12 Cassandra nodes, storing billions of messages" |
| Start of 2022 | "177 nodes with trillions of messages" |
| After migration | "177 Cassandra nodes to just 72 ScyllaDB nodes", each with 9 TB of disk (up from an average of 4 TB per Cassandra node) |

- **Partitioning:** messages are partitioned by **channel plus a "bucket"**, "a static time window". (The exact CQL key is not shown in the text, so we do not state it.)
- **IDs:** "Every ID we use is a Snowflake, making it chronologically sortable."
- **Problems on Cassandra:** **hot partitions** when many users read the same channel concurrently, **GC pauses** (including consecutive pauses needing manual reboots), and the **"gossip dance"**: taking nodes out of rotation to compact them, then returning them to pick up hints, repeated until the backlog cleared.
- **Data services (Rust):** services between the API monolith and the databases. **Request coalescing:** "If multiple users are requesting the same row at the same time, we'll only query the database once." **Consistent-hash routing** by a routing key (the channel ID for messages) sends requests for one channel to the same instance, so coalescing works.
- **Migration:** a Spark-based plan estimated ~3 months. A rewritten **Rust migrator** reading token ranges (checkpointed in SQLite) brought it to **"nine days"**, at up to **3.2 million messages per second**. A last stall at 99.9999% came from large uncompacted tombstone ranges. The cutover was in **May 2022**.
- **Results:** p99 historical-message fetch **40–125 ms → ~15 ms**. Message inserts **5–70 ms → a steady 5 ms**.

---

## 4. Voice `[CONFIRMED]` (2018 post, Jozsef Vass)

- **Voice servers** each have a **signaling** component (Elixir) and a **media relay**, a homegrown C++ **selective forwarding unit (SFU)** that forwards audio and video within channels and bridges browser and native clients.
- **Discovery:** voice servers report health and load into **etcd**. The Guilds service "assigns the least utilized voice server in the given region to the guild", and the client is told which one to use.
- **Client path:** one WebSocket to the gateway and a **second WebSocket to the voice server** for signaling, with **audio over UDP**.
- **Why client-server:** peer-to-peer "becomes prohibitively expensive as the number of participants increases", and relaying hides users' IP addresses. Because every client connects to the relay, **ICE is not needed**.
- **Other decisions:** custom signaling instead of SDP (~1000 bytes for native clients), **Salsa20** instead of DTLS/SRTP for speed, **silence suppression**, a customized C++ WebRTC build for native features like push-to-talk, client reconnect to a new voice server on failure.
- **Scale at the time:** **more than 850 voice servers in 13 regions (30+ data centers)**, **2.6 million+ concurrent voice users**, egress above **220 Gbps**, ~120 million packets/s.

---

## 5. How the parts fit (our synthesis)

Sending a message, as far as the posts support: the client's **WebSocket** reaches a **gateway/session** process `[CONFIRMED]`, a message is written through the API and **data services** into the message store `[CONFIRMED]` for storage, and the **guild process** publishes the event to every connected session, using Manifold to batch delivery `[CONFIRMED]`. The posts do not show the exact order of these steps (persist first or publish first), nor how the API monolith calls the guild process, so the flow in the diagram is labelled `[INDUSTRY PATTERN]` where it fills that gap.

---

## ⚠️ Reviewer notes

1. **Several figures people quote are not in the posts we read.** The 2019 post title says "11 million concurrent users", but in the text we retrieved the body does not state that number, and we did not find "26,000 events per second" or Read States there (Read States is in the separate 2020 post). The largest-guild figure given there (200,000) is an example, not a stated maximum.
2. **Third-party summaries of the storage post add figures we did not verify.** For example, a secondary write-up says MongoDB hit its limit around 100 million messages. Our extraction of the primary post did not cover MongoDB, so we make no MongoDB claim.
3. **The partition key.** Many write-ups state `(channel_id, bucket)` as the literal key. The post says "channel plus a bucket", so that is what we say.
4. **The old stack is not the current stack.** Elixir fan-out numbers are from 2017, and the Rust and ScyllaDB changes came later. Check the date on any figure before quoting it.
5. **"Discord Hammer"** and similar names circulate online but are not explained in the 2017 post.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the posts. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **scalability** (millions of concurrent sessions), **performance/latency** (fan-out, p99 reads), **availability**, **elasticity** around events, **operability** (the gossip-dance pain was an operability failure).
- **Style (Ch 13/17):** **service-based**, with a monolithic API tier in front of specialised services: gateway/guilds (Elixir), data services (Rust), voice (Elixir + C++), storage (ScyllaDB). Within the real-time tier it is an **actor-model**, pub/sub design.
- **Quanta (Ch 7):** voice is a separate quantum with its own fleet and failover. Message storage and the real-time fan-out can degrade independently.
- **Trade-off (First Law, Ch 1):** **simplicity of the actor model vs fan-out cost at scale.** Each guild as one process is simple and consistent, and it is also a bottleneck. Manifold, Rust and sharding exist to pay that cost down.
- **ADR sketch (Ch 19):** *"We will put a coalescing data-services layer in front of the message store, routed by channel. We accept an extra hop to avoid hot partitions hitting the database."*
- Plain English: put a front desk in front of the filing room so that fifty people asking for the same page cause one trip to the shelves.

---

## Interview questions to practice

1. A guild has 30,000 online members. Walk through delivering one message. Where does the first bottleneck appear?
2. Why partition messages by channel **and** a time bucket instead of channel alone?
3. How does request coalescing work, and why does it need consistent-hash routing in front of it?
4. Why does a circuit breaker fail Discord's thundering-herd case, and what did they use instead?
5. Voice: why client-server instead of peer-to-peer? What does an SFU do?
6. Cassandra → ScyllaDB: what did the garbage collector have to do with p99 latency?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: text, voice, large servers, history.
2. Estimate: concurrent users, events/s.
3. API: WebSocket gateway plus REST.
4. Design: sessions, guilds, data services, message store.
5. Deep dive: fan-out, hot partitions, coalescing.
6. Failure and scale: large guilds, GC pauses, voice failover.

**If it grows 10×**
- Fan-out cost: batch sends per node and offload hot paths to Rust.
- Hot channels: coalesce reads and route by channel.
- Storage ops: avoid GC-heavy databases for latency-critical data.

**Answer outlines** (try the questions above first)

<details><summary>A guild has 30,000 online members. Walk through one message.</summary>

The API accepts and stores it, the guild process publishes the event, and Manifold groups recipient sessions by node so each node gets one message and fans out locally.

</details>

<details><summary>Why partition messages by channel and time bucket?</summary>

It keeps one channel's recent messages together for fast reads while bounding partition size over time.

</details>

<details><summary>Why did coalescing need consistent-hash routing?</summary>

Requests for the same channel must reach the same service instance for identical concurrent reads to be merged into one query.

</details>

## 📚 Further reading

- The five Discord posts listed at the top.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (background on caching and consistency, secondary).
- Related in this repo: [03 Distributed KV store](03-distributed-kv-store.md) (the Cassandra lineage), [08 Chat (WhatsApp)](08-chat-whatsapp.md) (1:1 chat and store-and-forward), and [`neokim-post/13` Slack](https://github.com/allmonty/study/blob/main/architecture/neokim-post/13-how-slack-works.md).

## Sources and provenance

> **Kind:** real-system. Discord's engineering blog documents its real-time layer (Elixir sessions and guild processes), its Rust components, its message storage (Cassandra → ScyllaDB) and its voice servers. It does **not** publish a single full architecture diagram, so the picture below is assembled from five posts and has gaps.
> **Sources read on 2026-10-27 (all Discord Engineering):** [How Discord Scaled Elixir to 5,000,000 Concurrent Users](https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users) (2017-07-06) · [Using Rust to Scale Elixir for 11 Million Concurrent Users](https://discord.com/blog/using-rust-to-scale-elixir-for-11-million-concurrent-users) (2019-05-17) · [How Discord Handles Two and Half Million Concurrent Voice Users using WebRTC](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc) (2018-09-10) · [Why Discord is switching from Go to Rust](https://discord.com/blog/why-discord-is-switching-from-go-to-rust) (2020-02-04) · [How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages) (2023-03-06).
> **Dated material:** each post describes Discord at its publication date. The architecture has probably evolved since. Do not read 2017 numbers as current.
> **Tags:** `[CONFIRMED]` stated in a Discord post · `[INDUSTRY PATTERN]` standard practice, not stated for Discord · `[SPECULATIVE]` plausible.

---
## ✅ Verification log

*Fact-check, 2026-10-27, each post fetched and read. Numbers and quotes match the fetched text.*
- Verified (2017 post): date, GenServer sessions and guilds, mostly pub/sub, 30,000 concurrent users in large guilds, `send/2` 30–70 µs and 900 ms–2.1 s publish, Manifold mechanics, FastGlobal figures (7 µs, 17.5 s, 0.3 µs, 750 ms, ~30 s restarts), Semaphore design and the circuit-breaker reasoning, ~5 million concurrent users, 500,000 sessions per VM, ~5 guilds per user, 12 µs request/reply.
- Verified (2019 post): date, the SortedSet problem, each approach and its quoted timings, Rustler, "powers every single Discord guild", `sorted_set_nif`.
- Verified (2018 post): voice components, etcd discovery, least-utilised assignment, UDP audio, no ICE, Salsa20, silence suppression, 850 servers in 13 regions, 2.6 M concurrent voice users, 220 Gbps, 120 Mpps.
- Verified (2020 post): Read States role, Go GC spike every 2 minutes, LRU cache scan, Rust results, 8 million cache capacity.
- Verified (2023 post): date, 12 → 177 Cassandra nodes, 72 ScyllaDB nodes at 9 TB, channel + bucket partitioning, Snowflake IDs, hot partitions, GC pauses, gossip dance, Rust data services with coalescing and channel-based routing, nine-day Rust migrator at 3.2 M messages/s, tombstone stall, May 2022 cutover, latency numbers.
- Corrected/removed: the "11 million concurrent users", "26,000 events per second" and "Read States/Ring" attributions to the 2019 post (not found in the text we retrieved), "Discord Hammer" (not explained in the 2017 post), any MongoDB claim (not verified) and the literal `(channel_id, bucket)` key (the post only says channel plus bucket).
- Method note: the posts were fetched through a summarising tool, so "not found" means not found in the returned extract, not proven absent from the page.
- Scoped: the end-to-end send flow in section 5 is partly `[INDUSTRY PATTERN]` because no post shows the full path.
- Not verified: anything after 2023, current numbers, and whether the Elixir fan-out design is unchanged.
