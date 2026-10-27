# 29 — Live Streaming (Twitch)

*Real-system parts from Twitch's own engineering posts, plus a reference design for what Twitch does not publish. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A streamer sends one video stream (RTMP) to a nearby point of presence. Twitch carries it over a private backbone to an **origin** data center, where it is transcoded into several qualities and packaged as HLS. The segments travel down a tree of data centers to viewers, who pull them over plain HTTP. Chat is a separate real-time system: IRC-compatible edge servers accept messages, a rules service decides whether to deliver them, and a publish/subscribe layer fans them out. The hard parts are the cost of transcoding, picking which origin handles which stream, keeping delay low, and fan-out in a chat room with a very large audience.

**Key numbers** (all as published, with the year)
- Nearly a hundred points of presence worldwide, each connected to a private backbone `[CONFIRMED]` (2022 post).
- Origins hold "hundreds to thousands of servers" for transcoding `[CONFIRMED]` (2023 post).
- Latency went from about 15 s to about 10 s, then to about 3 s with what the interviewee calls Twitch's own "low-latency HTTP live streaming" (not necessarily Apple's LL-HLS), and to 1.5 s in some Korean cases `[CONFIRMED]` (2021 interview).
- Transcoding with the earlier approach reached only 2–3% of channels; a hardware transcoder aims at 10× capacity for 2× cost `[CONFIRMED]` (2021 interview).
- Average active viewers over 2.5 million, 1.3 trillion minutes watched a year, 7 million monthly streamers `[CONFIRMED]` (2023 post).
- Chat volume is **inconsistent in Twitch's own posts**: "over 10 billion messages a day" and "hundreds of billions of messages per day" appear in the same 2015 post. We treat it as unresolved.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Terminate streams at a nearby PoP, carry them on a private backbone | Streamers connect quickly; avoids the instability of the public Internet | Owning and running a backbone |
| Route each stream to an origin with a central controller (Intelligest) | Uses compute well across time zones and reroutes around a failing origin | A routing service that must stay correct and available |
| Transcode into several qualities | Viewers on any device and network can watch | Transcoding is computationally expensive; the main cost driver |
| HLS over HTTP, delivered through a tree of data centers | Cacheable, scales with viewers | Segmenting adds delay; lower delay needs more complex protocols |
| Chat as its own system with Edge, Pubsub and a rules service | Millions of connections and heavy fan-out, with moderation | A second large real-time system to run |

**Common mistakes**
- Designing one pipeline for video and chat. They have different failure modes and scale on different axes (bandwidth and CPU versus connections and fan-out).
- Forgetting that one stream becomes many: five qualities for each of 300,000 broadcasters is 1,500,000 streams to produce, as the interview's own example shows.
- Quoting Twitch chat volumes or transcoder details with confidence. Twitch does not publish a consistent figure or the transcoder internals.

---

## 🧒 Non-technical explanation

Picture a **local TV station that anyone can run from home**. A host talks into a camera. The signal goes to the nearest relay tower, then over the company's own cables to a big studio. The studio makes several copies of the show: sharp for people with fast connections, rougher for people on slow phones. Copies are cut into short clips and sent to regional offices, and each viewer's player keeps asking its nearest office for the next clip.

Meanwhile a separate **chat room** runs next to the show. Every message goes through a doorman who checks the rules, then through a loudspeaker system that repeats it to everyone in the room.

---

## TL;DR for engineers

- **Video path:** broadcaster → PoP (media proxy) → backbone → origin (transcode, package) → replication tree → viewer `[CONFIRMED]`.
- **Routing:** a central routing service decides which origin takes each stream, using live capacity data. It replaced static HAProxy configuration `[CONFIRMED]`.
- **Delivery:** HLS playlists and segments over HTTP. Low-latency HLS adds partial segments and playlist requests that wait for new data `[CONFIRMED]` (spec).
- **Chat:** IRC-compatible Edge, Clue for rules, Pubsub for fan-out, Room for viewer lists `[CONFIRMED]`.
- **Not published:** transcoder internals, the bitrate ladder, clip creation, and consistent chat rates `[SPECULATIVE]` where we fill in.

---

## 1. Requirements (design framing)

**Functional:** broadcast from encoder software · watch live on many devices · chat with moderation · save a recording (VOD) and make highlights or clips · discovery and notifications.

**Non-functional:** **glass-to-glass delay** low enough for conversation · **availability** when an origin or link fails · **cost** of transcoding and bandwidth · **spike tolerance** (a big channel can go from few viewers to millions) · **chat** that feels immediate.

**Clarifying questions:** how many concurrent streams and viewers? Target delay (a few seconds or sub-second)? Which devices? Is interaction (chat, polls) part of the product? Recording required? Budget for transcoding every channel?

---

## 2. The video path `[CONFIRMED]`

**Ingest.** The 2015 overview states the first step plainly: "We take RTMP video in, and then transport it to the transcode system." The 2022 ingest post adds that Twitch "maintains nearly a hundred points of presence (PoPs) in different geographic regions around the world", that each PoP "is connected to our private backbone network", and that streams received at a PoP are sent on to origin data centers. Using the backbone lets Twitch "overcome the instability of the public Internet, especially when delivering time-sensitive data like live video".

**Transcoding and packaging.** Origins "host the resources that are needed to provide computationally intensive media transformations, like video transcoding". The 2023 post says the transcoding system "takes an incoming Real Time Messaging Protocol (RTMP) stream from the creator, and turns it into an HLS-compliant stream" with "several variations of the stream with a range of video resolutions and bitrates". We do not know the exact ladder (which resolutions and bitrates); Twitch does not publish it in the posts we read.

**Distribution.** Once a stream is transcoded, the 2023 post says video distribution ensures delivery "as quickly as possible" through "a network of data centers distributed across the world, which are organized in a directed graph hierarchy we call a Replication Tree". A viewer's request goes to the nearest datacenter, which forwards it up the tree to the origin. Details of caching and tree shape are not given.

**Recording.** If recording is enabled, the system "stores a copy of all generated segments, thumbnails, and playlists in one of our Simple Storage Service (S3) buckets" (2023 post). Streamers can then cut highlights from the recording.

---

## 3. Choosing an origin: Intelligest `[CONFIRMED]`

**History.** Twitch started with one origin in Silicon Valley, with HAProxy at each PoP terminating streams and forwarding them. As origins spread around the world, each PoP "still ran HAProxy and statically sent live video streams to only one of the origins". The post lists the problems: broadcast activity follows a daily cycle, so each origin had to be sized for its region's peak instead of the global peak; the static configuration made surges and capacity loss hard to handle; origins have different sizes; and HAProxy could not detect complex origin failures, for example "an outage in a control plane or loss of backbone capacity".

**The replacement.** Twitch retired HAProxy and built **Intelligest** with two parts. The **media proxy** runs in every PoP, terminates the broadcaster's stream, and "can terminate any number of media transport protocols (e.g., RTMP or WebRTC)", so a single canonical protocol can be used inside the backbone. The **Intelligest Routing Service (IRS)** runs in AWS and makes the routing decisions; it does not control Layer 3 routing of the backbone.

**How IRS decides.** Phase one solved an optimisation problem offline (demand per PoP in, fractions of streams per origin out, maximising compute use under link and origin limits) and loaded the result into IRS. This was static, so two services were added: **Capacitor** "monitors the compute resources in every origin" and **The Well** monitors the backbone. With them IRS has a real-time view and "uses a randomized greedy algorithm to compute routing decisions". The post reports that Intelligest "is able to utilize 100% of the compute resources available to Twitch at the peak times", and that on origin failure IRS "can automatically direct new live video streams to an unaffected origin".

**Rules.** IRS is stateful and can pin certain channels to a particular origin, or send a primary and backup feed of the same event to the same origin.

---

## 4. Transcoding cost and delay `[CONFIRMED]` (2021 interview, 2023 post)

- **Scale of the problem.** The interview's illustration: with five quality levels and 300,000 broadcasters, "that's 1,500,000 different streams". The interviewee says they had hundreds of thousands of live channels at any moment.
- **Cost.** "Transcoding is computationally very expensive." When that engineer joined, only 2–3% of channels could be offered transcoding. A hardware transcoder lets them expand capacity "by 10 times, at only two times the cost". In 2023 the post says a prototype server using ASICs transcodes "at over 10x the scale of our previous solution".
- **Delay.** The player keeps a buffer to ride out bad connections, and "buffers can increase latency". Delay had gone from 15 s to about 10 s before the interviewee joined; Twitch then built "low-latency HTTP live streaming" and cut it to about 3 s, and 1.5 s in some Korean cases.
- **Surges.** "When a big channel goes live, you suddenly have a few million people watching a channel", something to "design for up front".

---

## 5. How HLS works and what low latency changes `[CONFIRMED]` (RFC 8216, HLS 2nd edition draft)

**Classic HLS (RFC 8216).** The stream is split into media segments listed in a playlist. A client "MUST periodically reload a Media Playlist file to learn what media is currently available". For a live playlist the server must publish a new version with at least one new segment "no earlier than one-half the target duration" and "no later than 1.5 times the target duration" after the previous version. A client that finds a changed playlist must wait at least the target duration before reloading; if unchanged it waits half. The RFC says "a typical target duration is 10 seconds"; the later second-edition draft, which this section also cites, says a typical target duration is 6 seconds, so treat 10 s as the 2017 example and 6 s as the current Apple guidance. The server must not shrink a live playlist below three target durations, because that "can trigger playback stalls". This design explains the delay: the player starts a few target durations behind the live edge (the three-target-duration playlist rule above points the same way), so with 6-second segments tens of seconds of delay is normal.

**Low-latency HLS (draft of the second edition).** The draft adds three mechanisms. **Partial segments** (`EXT-X-PART`) let a client fetch pieces of a segment before it is complete. **Blocking playlist reload**: the server "MUST defer responding to the request until the Playlist contains" the requested segment or part, so the client learns of new media immediately instead of polling. **Preload hints** (`EXT-X-PRELOAD-HINT`) let a client request a resource "before the resource is available" so the server holds the request until it can answer. The server also advertises `PART-HOLD-BACK`, the distance from the end of the playlist where clients should start, which "MUST be at least twice the Part Target Duration".

**Why this matters for design.** Each shortcut moves work from the CDN's cache toward origin-side state: a blocking request is held open, so the edge cannot answer it from a plain cache hit and must coalesce many waiting viewers onto one origin fetch (our design reasoning).

We did not read Twitch's own description of its low-latency HLS beyond the interview statement above, so we do not claim Twitch's implementation matches the draft in detail.

---

## 5b. A documented cousin of Twitch's stack: Amazon IVS, and the Clips API `[CONFIRMED]` with limits

**Amazon IVS.** AWS's July 2020 launch announcement says Amazon IVS "ingests the video, then automatically transcodes and optimizes it, making live video streams available within seconds" using "the same video technology Twitch uses for its live streaming service". Because AWS documents IVS publicly, its user guide is the closest primary description of what such a stack exposes to a broadcaster (it does not tell us Twitch's own settings):
- **Ingest:** H.264 video and AAC (LC) audio over RTMPS (RTMP over TLS 1.2 or later), RTMP, or SRT, a newer open-source protocol "designed to improve streaming over unreliable networks and protect against jitter, packet loss, and network bandwidth fluctuations".
- **Latency:** "Amazon IVS channels can deliver video with latency under 5 seconds"; a separate real-time tier (stages) is under 300 ms; and "for a traditional Over-The-Top (OTT) stream, latency may be as high as 30 seconds". For the lowest latency the IVS player must be used because third-party HLS players are not supported.
- **Keyframe interval trade-off:** the guide tells broadcasters to set the encoder's IDR/keyframe interval to 2 seconds (or 1 second for even lower latency). With 2 seconds, stream-start latency is approximately 6 to 7 seconds; with 1 second, 3 to 4 seconds. The 1-second setting can make the player's adaptive bitrate switch resolution more often and raise buffering. Intervals above 5 seconds are discouraged because segments may not begin with a keyframe, risking decode errors when viewers start playback or change quality. This shows concretely why segmenting and keyframe alignment (section 7) drive delay.
- **Restreaming:** the guide advises streaming directly to IVS because third-party restreaming services add latency.

**Clips (documented behaviour only).** Twitch's Create Clip API documentation says the call "captures up to 90 seconds of the broadcaster's stream", spanning the point from when the API was called (about 35 seconds before to 5 seconds after in its example); by default Twitch publishes up to the last 30 seconds, and the clip can be edited to 5 to 60 seconds through a URL valid for up to 24 hours. Creation is **asynchronous**: the API returns 202 Accepted, the client checks Get Clips, and if Get Clips has not returned the clip after 60 seconds the client should "assume it failed" (the page read on 2026-10-27 says 60 seconds; earlier snapshots of the same page said 15). It requires the broadcaster to be live and fails with 403 if the broadcaster restricted clipping to followers or subscribers or disabled it. This describes the interface, not the implementation: it is consistent with cutting a clip from a recent-segment buffer of the live stream, but no source we read says how it is built.

## 6. Chat `[CONFIRMED]` (2015 and 2023 posts, developer docs)

**Components.** Chat "is a highly scalable real-time distributed system written in Go" (2015). The 2015 post names four parts:
- **Edge** "Receives and distribute messages between clients and backend services" and "speaks the IRC protocol over both raw TCP and WebSockets".
- **Pubsub** "Distributes messages internally across Edge nodes", and with Edge forms "a hierarchical message distribution system which executes massive fanout".
- **Clue** performs "analysis on user actions" in a business-logic pipeline, such as whether the user is banned or a subscriber.
- **Room** aggregates viewer-list data across all edges.

The 2023 post describes the send path: Edge accepts a message from a client and forwards it to Clue for processing; **Clue and Zuma** "evaluate viewer messages against existing rules, like the channel's automod settings, to determine if a message should be delivered or rejected"; accepted messages are delivered through Pubsub and Edge to subscribed clients. A related **Pubsub** system (Edge, Control, Broker) publishes backend events such as viewer counts and poll status; the Broker "fans the message out to all edges with a subscription to the message's topic".

**Limits.** The developer documentation limits what a chatbot may send: 20 messages per 30 seconds, and 1 message per second per channel unless the account is the broadcaster, a moderator or a VIP (who get 100 per 30 seconds). If a bot exceeds the limits, Twitch ignores its messages for 1 hour, except in chats where the bot's account is the broadcaster, a moderator or a VIP. The IRC server sends `PING` and the client must answer `PONG`, otherwise the server terminates the connection (described on the [IRC documentation page](https://dev.twitch.tv/docs/chat/irc/)).

**What is not published.** Fan-out mechanics per channel (how a very large room is partitioned over Edge nodes), storage of chat history, and consistent message rates. The 2015 post says both "over 10 billion messages a day" and "hundreds of billions of messages per day", and the 2023 post repeats the larger figure. Use neither as a design input; derive your own numbers from assumptions.

---

## 7. Reference design for what Twitch does not publish `[INDUSTRY PATTERN]`

```
broadcaster ─RTMP─► PoP media proxy ─► ingest router (capacity-aware) ─► origin: transcoder ─► packager
                                                                             │
 viewer ◄─HLS/LL-HLS─ CDN / replication tree ◄──────────────────────────────┘ ─► VOD store (object storage)
 viewer ◄─WebSocket/IRC─ chat edge ◄─ pubsub ◄─ moderation ◄─ chat edge ◄─ viewer
```

- **Authentication of the broadcaster:** a secret stream key checked at the PoP before accepting video.
- **Segmenting:** the encoder sends keyframes at a regular interval so every quality's segments line up and the player can switch quality at segment boundaries.
- **Adaptive bitrate:** the player measures throughput and chooses a quality per segment.
- **Hot channels:** coalesce requests at each tree level so one origin fetch serves many viewers; pre-warm capacity when a large event is scheduled.
- **Chat fan-out:** shard rooms across edge nodes; for very large rooms, sample or aggregate for display and apply slow mode, because every viewer cannot read every message. This is the same family of problem as [09 Discord](09-discord.md) and [08 WhatsApp](08-chat-whatsapp.md).
- **Clips:** keep a rolling window of recent segments so a clip can be cut from the live buffer. Twitch documents the clip interface (section 5b: asynchronous, a 90-second capture window, 5 to 60 seconds published) but no source we read describes the implementation, so the buffer design is ours.
- **Delay versus resilience:** a bigger player buffer survives bad networks; a smaller one lowers delay. Offer a latency mode and fall back automatically.

For video distribution mechanics and caches see [12 YouTube](12-youtube.md) and [13 Netflix](13-netflix.md).

---

## 8. Failure scenarios

- **An origin loses compute or backbone capacity.** Intelligest reads this from Capacitor and The Well and directs new streams elsewhere `[CONFIRMED]`. Streams already on that origin are not covered by the post, so we do not claim how they recover; a reference design has the broadcaster's encoder reconnect and be routed again `[INDUSTRY PATTERN]`.
- **A PoP is lost.** Not described in the posts. Broadcasters reconnect to another PoP by DNS or anycast; this depends on the network design and is `[SPECULATIVE]`.
- **A surge on one channel.** The replication tree absorbs viewer load; chat load needs rate limits and slow mode `[INDUSTRY PATTERN]`.
- **Chat service degraded.** Video keeps working because chat is a separate system `[INDUSTRY PATTERN]`.

---

## 9. Capacity reasoning (illustrative)

- Streams to produce = broadcasters × qualities. The interview's example gives 300,000 × 5 = 1,500,000.
- Chat fan-out is deliveries = messages per second × viewers in the room. A channel with 100,000 viewers and 10 messages per second would need 1,000,000 deliveries per second (illustrative; not Twitch data).
- Egress bandwidth = concurrent viewers × average bitrate. With 2.5 million average active viewers (the 2023 figure) at an assumed 4 Mbit/s the figure would be about 10 Tbit/s, but the bitrate is our assumption and Twitch does not publish a bandwidth number in the posts we read.

---

## ⚠️ Reviewer notes

1. **Twitch's published chat volumes disagree.** The 2015 overview says 10 billion a day in one place and hundreds of billions per day in another, and the 2023 post says hundreds of billions. We did not resolve this.
2. **The 2015 scale bullets are ambiguous.** "Over 30,000 people streaming video" next to "over 2 million concurrent video streams" cannot both describe the same quantity; the second probably means concurrent viewers. We do not use either as a design input.
3. **The 2021 interview contains a claim of "more than 1.5 million people" streaming at any moment,** which conflicts with its own "hundreds of thousands of live channels". We did not use it.
4. **Posts are from 2015 to 2023.** The architecture may have changed since; the posts do not say.
5. **Low-latency HLS is described from the specification draft,** not from Twitch's implementation.
6. **IVS is a related product,** and AWS's statement that it uses the same technology as Twitch (2020) does not mean Twitch uses the same settings or has not changed since. **Not read:** WebRTC details, CMAF, and any talk on the replication tree.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from Twitch's posts. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (glass-to-glass delay), **elasticity** (spikes on single channels), **availability**, **cost efficiency** (transcoding and bandwidth), **scalability** of fan-out.
- **Style (Ch 13):** **service-based** with two very different subsystems, video (a pipeline) and chat (event-driven fan-out), joined by the channel identity.
- **Quanta (Ch 7):** video ingest/transcode, video delivery, chat and VOD are separate quanta, which is why chat can fail without stopping video.
- **Trade-off (First Law, Ch 1):** **delay vs resilience and cost.** Short segments and small buffers lower delay and raise load on origin and risk of stalls.
- **ADR sketch (Ch 19):** *"We will route each ingest stream to an origin chosen by a controller that sees live capacity. We accept a central routing service in exchange for efficient use of compute and automatic avoidance of failing origins."*
- Plain English: a station with a smart dispatcher for its studios, and a separate chat hall with doormen.

---

## Interview questions to practice

1. Walk me through how a live stream gets from a streamer to a viewer.
2. Why transcode, and what makes it the expensive part?
3. How would you choose which data center processes a given stream?
4. Why is HLS delayed by several seconds, and how can you lower the delay?
5. How would you design chat for a channel with a million viewers?
6. What happens when an origin fails mid-stream?
7. How would you add clips and a recording (VOD)?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: concurrent streams and viewers, target delay, devices, chat features, recording.
2. Estimate: streams × qualities, viewer egress bandwidth, chat deliveries per second.
3. API: stream key and ingest endpoint; playback by playlist URL; chat over WebSocket.
4. Design: PoP ingest, capacity-aware routing to origins, transcoder and packager, CDN tree, VOD store, chat edge and pubsub.
5. Deep dive: segmenting and delay (HLS versus low-latency HLS), chat fan-out and moderation.
6. Failure and scale: origin loss, hot channel, chat overload, cost of transcoding every channel.

**If it grows 10×**
- Transcoding cost dominates: hardware encoders, and transcode only channels with enough viewers.
- Origins and backbone: add capacity-aware routing and more origins near streamers.
- Chat: shard rooms, limit rates, and sample very large rooms.

**Answer outlines** (try the questions above first)

<details><summary>How would you choose which data center processes a stream?</summary>

A routing service sees each origin's free compute and each backbone link's load, and sends new streams where there is room, with rules for special channels. Twitch's version first solved this offline from daily demand patterns, then added live capacity feeds so it can avoid a failing origin.

</details>

<details><summary>Why is HLS delayed, and how do you reduce it?</summary>

The player works with whole segments, several seconds each, and keeps several buffered. Reduce it with shorter segments and partial segments, and with blocking playlist requests so the player hears about new data at once. Each step costs more requests and origin load.

</details>

<details><summary>How do you design chat for a million-viewer channel?</summary>

Accept messages at edge servers, check rules once, publish to a topic for the channel, and let each edge fan out to its own connected clients. Shard the room across edges, add slow mode and per-user rate limits, and for display sample or batch messages because nobody can read every one.

</details>

## 📚 Further reading

- The Twitch posts and specifications listed under Sources and provenance.
- [`neokim-post`](https://github.com/allmonty/study/blob/main/architecture/neokim-post) notes on chat and video for basics.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [08 WhatsApp](08-chat-whatsapp.md), [09 Discord](09-discord.md), [12 YouTube](12-youtube.md), [13 Netflix](13-netflix.md), [21 Game matchmaking and lobby chat](21-game-matchmaking-lobby-chat.md).

## Sources and provenance

> **Kind:** real system, partly reference design. The posts below describe real Twitch components. The transcoder internals, the bitrate ladder, clips, chat fan-out detail and current message rates are **not** published in what we read, so section 7 is a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Twitch Engineering, [*Twitch Engineering: An Introduction and Overview*](https://medium.com/twitch-engineering/twitch-engineering-an-introduction-and-overview-36ceeb8875de) (Dec 2015) · Twitch, [*Ingesting Live Video Streams at Global Scale*](https://blog.twitch.tv/en/2022/04/26/ingesting-live-video-streams-at-global-scale/) (Apr 2022) · Twitch, [*Low Latency, High Reach: Creating an Unparalleled Live Video Streaming Network at Twitch*](https://blog.twitch.tv/en/2021/10/25/low-latency-high-reach-creating-an-unparalleled-live-video-streaming-network-at-twitch/) (Oct 2021, an interview) · Twitch, [*Twitch State of Engineering 2023*](https://blog.twitch.tv/en/2023/09/28/twitch-state-of-engineering-2023/) (Sep 2023) · [Twitch developer documentation, Chat](https://dev.twitch.tv/docs/chat/) · Pantos and May, [RFC 8216, HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216) (2017) · Pantos, [HTTP Live Streaming 2nd Edition, draft-pantos-hls-rfc8216bis-22](https://www.ietf.org/archive/id/draft-pantos-hls-rfc8216bis-22.txt) (1 May 2026; the low-latency claims were also checked in revision -17).
> **Also read on 2026-10-27:** Amazon IVS Low-Latency Streaming [user guide](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/what-is.html) and [Reducing Latency](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/streaming-config.html) pages · AWS, [Introducing Amazon Interactive Video Service](https://aws.amazon.com/about-aws/whats-new/2020/07/introducing-amazon-ivs/) (15 July 2020) · Twitch developer documentation, [Create Clip](https://dev.twitch.tv/docs/api/reference/#create-clip).
> **Dated material:** posts range from 2015 to 2023. The Twitch pages are rendered by scripts, so we read them through an Internet Archive copy.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading the full text of each source (Archive copies for the Twitch pages, local copies of the RFC and draft). Quotations are confirmed by `npm run verify`.*
- Verified in the 2015 post: RTMP in, transcode to multiple HLS streams, distribution to PoPs, VOD archive; chat in Go with Edge (IRC over TCP and WebSockets), Pubsub, Clue, Room; both chat-volume statements; the ambiguous scale bullets.
- Verified in the 2022 post: nearly a hundred PoPs, private backbone, origins, HAProxy history and its five problems, Intelligest media proxy and IRS, offline optimisation, Capacitor and The Well, randomized greedy algorithm, 100% compute use at peak, automatic redirect on origin failure.
- Verified in the 2021 interview: 1,500,000 streams example, transcoding reach of 2–3% of channels, hardware transcoder 10× capacity for 2× cost, delay history (15 s, 10 s, 3 s, 1.5 s in Korea), buffer trade-off, surge remark; and the 1.5 million statement that conflicts with other figures.
- Verified in the 2023 post: viewer, minutes and streamer figures, hundreds to thousands of servers per origin, RTMP to HLS-compliant stream, ASIC prototype, Replication Tree, VOD to S3, chat send path with Clue and Zuma, Pubsub Edge, Control and Broker.
- Verified in the chat documentation: send limits and the PING/PONG rule.
- Verified in RFC 8216 and the 2nd-edition draft: reload and playlist rules, partial segments, blocking reload, preload hints, `PART-HOLD-BACK`.
- Labelled industry pattern or speculative: stream key authentication, segmenting alignment, adaptive bitrate, request coalescing, chat sharding and sampling, clips, failure recovery for streams already on a failed origin, PoP loss.
- Verified in the Amazon IVS pages and the Create Clip documentation: the quoted ingest, latency and keyframe-interval statements, the 2020 announcement wording, and the clip window, publish length, asynchronous flow and error conditions. The IVS settings are not claimed for Twitch itself.
- Not read: WebRTC details, CMAF, replication-tree talks, the chat documentation's join limits beyond the sending limits.
- Corrected (independent review, 2026-10-27): the Create Clip timeout is 60 seconds in the live API reference, not 15; an older version of the page said 15. The quotation check did not catch it because the number sits outside the quoted words.
