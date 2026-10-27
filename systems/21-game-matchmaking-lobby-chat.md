# 21 — Online Game: Matchmaking + Lobby Chat

*A reference design built on verified building blocks. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Matchmaking collects waiting players as tickets, forms balanced groups with a match function, allocates a ready dedicated server, and writes the connection details back to every ticket. Open Match provides the framework, Agones the server fleets, and TrueSkill-style ratings track uncertainty. Lobby chat and push events run on regional shards, as in Riot's published designs.

**Key numbers**
- Agones allocation atomically moves a Ready server to Allocated `[CONFIRMED]`.
- Riot chat clusters of 6–12 nodes per region, load-tested to 30+ servers `[CONFIRMED]` (2015).
- TrueSkill tracks uncertainty and infers individual skill from team results `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Widening search windows over wait time | Bounded queues | Less balanced games for long waiters |
| Warm server fleets | Fast allocation | Idle capacity |
| Regional shards | Latency and isolation | No cross-region play by default |

**Common mistakes**
- Saying 'use Open Match' as if it chooses who plays whom: you write the match function.
- Putting rating updates on the queue's critical path.
- Claiming a named game's matchmaking from these building blocks.


---

## 🧒 Non-technical explanation

Matchmaking is a **sports league's scheduler**. Hundreds of thousands of players walk in at once and say "I want a game." The scheduler must quickly put them into **fair, ready-to-play groups** (similar skill, close enough that nobody lags) and then **hand each group the key to a pitch** (a game server). Waiting forever for a perfect match is as bad as a lopsided one, so the scheduler **loosens its rules the longer you wait**.

The lobby chat is the **clubhouse** next to the pitch: friends talk, form parties, and are told "your match is ready". It has to work whether you are playing or not, and for each region on its own.

---

## TL;DR for engineers

- **Three jobs:** (1) **find** matches (a matchmaker over a pool of waiting players), (2) **start** them (allocate a ready dedicated game server), (3) **talk** (lobby/party chat and push events like "match found").
- **Open Match's model:** a **Game Frontend** creates a **Ticket** per request. The **Director** asks the backend for matches for each **Match Profile**. A **Match Function (MMF)** queries tickets and returns **Matches**. An optional **Evaluator** de-duplicates overlapping proposals. The Director gets a game server, writes an **Assignment** onto every ticket, and the frontend returns it to the client `[CONFIRMED]`.
- **Agones:** dedicated game servers on Kubernetes. A **Fleet** is "a set of warm GameServers that are available to be allocated from". A **GameServerAllocation** "atomically allocate[s]" one, which moves it to **Allocated** `[CONFIRMED]`.
- **Skill rating:** TrueSkill "can be viewed as a generalisation of the Elo system", tracks **uncertainty** about each player's skill, models draws, handles any number of competing entities and infers individual skills from **team** results `[CONFIRMED]`.
- **Chat at Riot (2015):** XMPP, one **session process per player**, deployed **per region ("shard")**, clusters of 6–12 nodes sharing only a few fully replicated in-memory tables `[CONFIRMED]`. **RMS (2017)** pushes server-side state changes to clients over WebSockets with an Edge tier and a Routing tier `[CONFIRMED]`.
- **The core trade-off is match quality vs wait time**, usually managed by widening search criteria as a ticket waits `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** queue for a game mode (solo or **party**) · find a match with similar skill and acceptable latency · accept/decline ("ready check") · allocate a server and connect · **lobby/party chat** and friend invites · rating updates after the match · **backfill** (fill a slot when someone leaves) · reconnect to an in-progress match.

**Non-functional:** **time-to-match** (seconds to tens of seconds) · **match quality** (fairness) · **scale** to a very large number of concurrent players · **regional isolation** (latency) · **availability** (queues and chat up during peaks) · **fairness and anti-abuse**.

**Clarifying questions:** team size and mode (1v1, 5v5, battle royale with 100)? Is skill hidden (MMR) or ranked-visible? Cross-region play allowed? Are parties allowed to mix sizes? Is there backfill? What is the target maximum wait?

---

## 2. Matchmaking with Open Match `[CONFIRMED]` (Open Match docs)

Open Match describes itself as "an open-source game matchmaking framework that simplifies building a scalable and extensible Matchmaker", giving developers "full control over how to make matches". The docs state that the **matching logic is yours**: "The core matchmaking logic is implemented as a Match Function service." The overview does not discuss rating or MMR, so skill rules live in your match function.

| Component | Role (from the matchmaker guide) |
|---|---|
| **Game Frontend** | "Receives the matchmaking request from the game client", authenticates the player, creates the request and later retrieves the **Assignment** |
| **Ticket** | "Open Match creates a Ticket and indexes its SearchFields." Each ticket joins a pool of players that Open Match actively considers |
| **Match Profile** | Defines the match types the Director can serve |
| **Match Function (MMF)** | Receives profiles, queries tickets that fit, returns **Matches** |
| **Director** | "Understands the types of matches (MatchProfiles) that can be served." Requests matches from the backend, **gets game servers from the allocation system**, and sets Assignments |
| **Evaluator** (optional) | Concurrent match functions can produce **overlapping** matches, so the evaluator "deduplicate[s] Match proposals before returning results". A default evaluator is provided |
| **Backfill** | Listed in the docs' navigation. Not described in the pages we read |

**The flow:** (1) the frontend asks Open Match to create a Ticket. (2) The Director periodically calls `FetchMatches` on the backend for a profile. (3) The backend triggers the match function, which queries tickets and builds a Match. (4) The backend returns the Match to the Director. (5) The Director requests a game server from the allocation system and **creates an Assignment** with connection details. (6) It calls `SetAssignment` to store it on **every ticket in the match**. (7) The frontend fetches the Assignment and returns it to the client, which connects and plays.

**What Open Match does not tell you** (our reading of what the pages do *not* say): whether it allocates game servers itself (the Director uses "the allocation system"), or how to rate players. Those are your integrations.

---

## 3. Rating players: TrueSkill `[CONFIRMED]`

From the paper's abstract: "We present a new Bayesian skill rating system which can be viewed as a generalisation of the Elo system used in Chess. The new system tracks the uncertainty about player skills, explicitly models draws, can deal with any number of competing entities and can infer individual skills from team results. Inference is performed by approximate message passing on a factor graph representation of the model." It appeared in *Advances in Neural Information Processing Systems 20*. The abstract says it was used "in a large-scale commercial online gaming service under the name of TrueSkill" without naming the service.

**Why it matters for the design** (our reading, `[INDUSTRY PATTERN]`):
- A rating is a **distribution, not a number**: a new player has **high uncertainty**, so the system can learn fast and the matchmaker can treat them differently.
- **Team results** update **individual** ratings, which matters for 5v5 and free-for-all.
- Rating update is a **post-match, asynchronous job** that reads the result and writes new ratings. It does not belong on the queue's critical path.
- The matchmaker usually needs a **single comparable number** per player. Choosing how to combine mean and uncertainty (e.g. a conservative estimate) is a design choice that the sources we read do not fix, so state your own.

---

## 4. Allocating servers with Agones `[CONFIRMED]`

- "**Agones** is a library for hosting, running and scaling dedicated game servers on Kubernetes." Features include running and updating **Fleets** without shutting down game servers with active players, an integrated game-server **SDK** for lifecycle management, and **allocation strategies**.
- A **GameServer** is a Kubernetes custom resource that creates a backing **Pod**. The pages show it reaching **Ready** ("ready to accept connections") and **Shutdown** ("on the way to being deleted"), and `SDK.Shutdown()` shuts the server down.
- A **Fleet** is "a set of warm GameServers that are available to be allocated from". `replicas` is "the number of GameServers to keep Ready or Allocated". Under the `Recreate` update strategy, a template change "terminates all non-allocated GameServers".
- A **GameServerAllocation** "atomically allocate[s] a GameServer out of a set of GameServers" and returns its details: **address and ports**, plus the game-server and node names. The state filter defaults to **Ready**. A successful allocation sets the state to **Allocated**, "active and should not be removed until SDK.Shutdown() is called or it is manually deleted". Selectors are an **ordered list**: "If the first selector is not matched, the selection attempts the second selector, and so on."
- **Scheduling strategies:** **Packed** (default, "aimed at dynamic Kubernetes clusters", bin-packs resources) and **Distributed** ("aimed at static Kubernetes clusters", spreads across the cluster).

**Design consequence** `[INDUSTRY PATTERN]`: keep a **warm buffer** of Ready servers per region and mode so allocation is a quick lookup, not a cold start. Autoscale the fleet on queue depth and the allocated/ready ratio, and handle "no Ready server" as a back-pressure signal to the matchmaker.

---

## 5. Lobby and chat: what Riot published `[CONFIRMED]`

### Chat service (2015)
- **Protocol:** XMPP. Servers are written "primarily in Erlang" (90% Erlang, 10% C for XML parsing, SSL and string handling).
- **Regional shards:** "We deploy chat services on a per-region basis (we call them 'shards')". Players cannot message across shards, and servers cannot use data from other regions.
- **Cluster:** each shard is one cluster of **six to twelve** machines, each node "fully autonomous and replaceable". Half the nodes can be shut down for upgrades without interrupting service.
- **Session handling:** each connecting client opens a persistent encrypted TCP connection. A load balancer picks a server (round-robin), which creates a dedicated Erlang **`c2s` process** holding the socket, parser, friends and ignore lists, last presence, name and rate-limit configuration.
- **Shared state:** servers share "only a few internal key-value tables that are fully replicated in-memory" via **Mnesia**, so session lookups are **local reads**. The cost is that every update replicates to all nodes. Riot says load tests showed clusters of at least **30 servers** with no degradation.
- **Netsplits:** nodes drop session entries for a node they lose and re-download them when it returns, so the cluster **self-heals**.
- **Message path:** sender's `c2s` validates (rate limit, spoof check, ignore/friends lists), looks up the recipient's session in the routing table. If **offline**, the message is **persisted** (MySQL for legacy shards, Riak for new ones) until next login. If online, it goes to the recipient's `c2s` process by Erlang message passing.
- **Internal REST** interfaces expose things like the social graph to other services.

### Riot Messaging Service (RMS, 2017)
- A backend service so other services can **publish** messages and clients **receive** them, "specifically designed to handle service to client messaging", philosophically "similar to a mobile push notification service".
- **Two tiers:** **RMS Edge** hosts client **encrypted WebSocket** connections (independent servers, so "100% linearly scalable"), and **RMS Routing** holds "a global, distributed table mapping player identifiers to RMSE nodes". Edge nodes tell routing about each session registered or terminated. Routing also processes published messages and tracks edge health.
- Messages are small JSON documents naming a **resource**, a **service**, a **version** and **recipients**, optionally with a short payload. The client then re-fetches state from the owning service.
- The post says its goal was servers that can support "10 million player connections on a single box" (a goal in the intro. We did not read the details).

**What this gives a lobby:** chat (person-to-person and group), presence ("online in lobby", "in a match"), party invites, and a **push channel** for "match found", "ready check" and "assignment ready" events, which are exactly RMS-style service-to-client messages `[INDUSTRY PATTERN]` (our application of the published design).

---

## 6. Putting it together `[INDUSTRY PATTERN]` unless tagged

```
Client ──► Game Frontend ──► create Ticket (mode, rating, region latencies, party)  ┐
   ▲                                                                                 │ pool
   │ "match found" / ready check (push)                       Director ◄─────────────┘
   │                                                              │ FetchMatches(profile) → Match Function → Evaluator [CONFIRMED]
Lobby chat + RMS-style push ◄──────────────── Assignment ◄── allocate Ready server (Agones) [CONFIRMED] ◄── Director
   │                                                                  │
   └──────────────► connect to Game Server (UDP, dedicated) ◄──────────┘
After match: result ──► rating service (TrueSkill-style) ──► profile store
```

- **Ticket contents:** game mode, rating (and uncertainty), measured **latency to each region** (the client pings candidate regions), party members, preferences. Partition queues by **region and mode**.
- **Match function:** collect compatible tickets, form teams, and balance them. **Widen** acceptable rating and latency windows as a ticket's wait time grows, trading quality for speed.
- **Parties:** match the party as one unit, using a representative rating (e.g. the highest or a weighted mix) and a rule against extreme skill gaps. Both are policy choices.
- **Ready check:** if anyone declines, the others return to the queue with **priority** and the declining player is penalised or dropped.
- **Backfill:** when a player leaves a match, create a backfill request so the matchmaker can fill the slot.
- **Reconnect:** keep the Assignment and server address on the player's session so they can rejoin within a window.
- **Regional isolation:** like Riot's chat shards, run each region's matchmaker, fleet and chat independently, and keep any cross-region features asynchronous.

---

## ⚠️ Reviewer notes

1. **Open Match is a framework, not a matchmaker.** The match logic ("Match Function") is the part you write. Saying "use Open Match" does not answer "how do you decide who plays whom".
2. **TrueSkill's formulas were not read.** The PDF's text would not decode, so we cite only the abstract. We therefore do not state how mean and uncertainty are combined, or any match-quality formula.
3. **Search-summary details are not claims.** A web search described Riot's persistence move from MySQL to Riak with CRDT merging for friends lists. We read the *Servers* post, which mentions MySQL and Riak for offline message storage, but not the *Persistence* post, so we state only what the Servers post says.
4. **Agones docs pages are thin on some states.** The pages we read mention Ready, Shutdown and Allocated, but not the full lifecycle (e.g. Scheduled or RequestReady), so we do not list it.
5. **Do not claim a particular game's matchmaking.** None of the sources describe how a named game (League, Valorant, Overwatch, Fortnite) matches players. They describe the building blocks.
6. **Chat numbers are from 2015.** The six-to-twelve nodes, 30-server load tests and the 1.7M friendships figure describe Riot's system then.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (time-to-match, chat latency), **scalability** and **elasticity** (peak hours, new releases), **availability**, **fairness** (a domain-specific quality), and **isolation** between regions.
- **Style (Ch 13, 14, 17):** **service-based** (frontend, matchmaker, allocation, rating, chat) with an **event-driven** push channel. The Open Match pipeline (frontend → director → match function → evaluator) is itself a small pipeline.
- **Quanta (Ch 7):** per-region, per-mode **quanta**. Chat shards are separate quanta by design (Riot's shards). Game servers are **ephemeral quanta**, each with its own lifetime.
- **Trade-off (First Law, Ch 1):** **match quality vs wait time.** A stricter match function gives fairer games and longer queues. The widening-window policy is how you buy time.
- **ADR sketch (Ch 19):** *"We will run an independent matchmaker, game-server fleet and chat cluster per region, and widen rating and latency windows as tickets age. We accept that a player in a small region may get a less balanced game rather than waiting."*
- Plain English: a scheduler that relaxes its rules the longer you wait, a pitch ready before you arrive, and a clubhouse in each town.

---

## Interview questions to practice

1. Design matchmaking for a 5v5 game. What goes in a ticket, and how does the match function form balanced teams?
2. A player has waited 90 seconds. What does your system do differently from second 5?
3. How do you allocate a game server in under a second? What if none is Ready?
4. How do you handle a party of three that queues with two other solos?
5. Someone leaves 30 seconds into the match. Walk through backfill.
6. Design the lobby chat for 1M concurrent users. How do you route a message to an online friend and to an offline one?
7. Why use regional shards for chat and matchmaking, and what do you lose?
8. How would you update ratings after a team match, and where does that run?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: mode, team size, parties, regions, backfill.
2. Estimate: concurrent queue size and match rate.
3. API: queue, ready check, assignment.
4. Design: frontend, ticket pool, match function, allocation, chat.
5. Deep dive: rating, widening, parties, backfill.
6. Failure and scale: no ready server, declines, disconnects.

**If it grows 10×**
- Queue size: partition by region and mode.
- Server demand: autoscale the warm fleet on queue depth.
- Chat: more nodes per shard with local session reads.

**Answer outlines** (try the questions above first)

<details><summary>A player has waited 90 seconds. What changes?</summary>

The match function widens the acceptable rating and latency windows for that ticket, trading match quality for time.

</details>

<details><summary>How do you allocate a server in under a second?</summary>

Keep a warm buffer of Ready servers per region and mode, and allocate atomically, treating an empty buffer as back-pressure.

</details>

<details><summary>How do parties queue?</summary>

As one ticket with a representative rating and a rule against extreme skill gaps, matched as a unit.

</details>

## 📚 Further reading

- The sources listed at the top. Also the Open Match and Agones documentation home pages, and [Riot's *Chat Service Architecture: Protocol* and *Persistence*](https://technology.riotgames.com/news/chat-service-architecture-protocol) (the latter not read here).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [08 Chat (WhatsApp)](08-chat-whatsapp.md), [09 Discord](09-discord.md) (voice and real-time fan-out), [10 Notification system](10-notification-system.md), [15 Uber](15-uber-proximity-dispatch.md) (matching in batches), [02 Rate limiter](02-rate-limiter.md).

## Sources and provenance

> **Kind:** reference design built on verified components. Studios rarely publish how their matchmaker decides *who plays whom*, but there is good public material on the **pieces**: Google/Unity's open-source **Open Match** (matchmaking framework) and **Agones** (game-server fleets on Kubernetes), Microsoft's **TrueSkill** skill-rating paper, and Riot Games' engineering posts on its **chat service** and **messaging service**. The rest (queue tuning, party handling, latency weighting) is standard practice `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Open Match docs: [Overview](https://open-match.dev/site/docs/overview/) and [Matchmaker guide](https://open-match.dev/site/docs/guides/matchmaker/) · Agones docs: [Overview](https://agones.dev/site/docs/overview/), [GameServerAllocation reference](https://agones.dev/site/docs/reference/gameserverallocation/), [Fleet reference](https://agones.dev/site/docs/reference/fleet/), [Create a GameServer](https://agones.dev/site/docs/getting-started/create-gameserver/) · Herbrich, Minka, Graepel, [*TrueSkill: A Bayesian Skill Rating System*](https://www.microsoft.com/en-us/research/publication/trueskilltm-a-bayesian-skill-rating-system/) (NIPS 2006; we read the Microsoft Research page's abstract, because the PDF's text would not decode) · Riot Games Tech Blog: [Chat Service Architecture: Servers](https://technology.riotgames.com/news/chat-service-architecture-servers) (2015-09-23) and [Riot Messaging Service](https://technology.riotgames.com/news/riot-messaging-service) (2017-02-28).
> **Not read:** studio matchmaking internals, Blizzard/Valve/Epic material, netcode, anti-cheat, the Riot *Persistence* post (it appeared only in a search summary), and TrueSkill's formulas. We make no claims about those.
> **Dated material:** the Riot posts are from 2015 and 2017. Open Match's docs show release 1.8.0 and were last modified 2025-06-17 (a newer "Open Match 2" is referenced).
> **Tags:** `[CONFIRMED]` stated by a primary source we read · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible, or a tuning choice.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* Open Match, Agones and Microsoft Research pages were fetched. The two Riot posts were downloaded and read as text.
- Verified in Open Match docs: the framework description, Game Frontend, Ticket and SearchFields, Match Profile, Match Function, Director, optional Evaluator and its default, and the seven-step ticket-to-assignment flow. Backfill is only listed. The overview says nothing about rating or whether it allocates servers. Release 1.8.0 and the 2025-06-17 modification date.
- Verified in Agones docs: the library description, Fleets as "a set of warm GameServers", `replicas` meaning, `Recreate` terminating non-allocated servers, GameServerAllocation atomic allocation, default Ready filter, Allocated semantics, ordered selectors, Packed vs Distributed strategies, response fields. The GameServer page shows Ready and Shutdown only.
- Verified in Microsoft Research's page: the TrueSkill abstract sentences (Elo generalisation, uncertainty, draws, any number of entities, team results, message passing on a factor graph), venue NIPS 20. The abstract does not name Xbox Live or Halo 2, so we do not state them.
- Verified in Riot's *Servers* post (2015-09-23): XMPP, Erlang 90% / C 10%, per-region shards, six to twelve nodes, c2s session processes and their contents, Mnesia-replicated tables with local reads, 30-server load-test claim, netsplit recovery, the message path including offline persistence in MySQL (legacy) or Riak (new shards).
- Verified in Riot's *Messaging Service* post (2017-02-28): the problem, the push-notification analogy, Edge (WebSocket) and Routing (global player-to-node table) tiers, linear scalability of Edge, the message format, and the "10 million player connections on a single box" goal in the intro.
- Removed: any claim about TrueSkill formulas, a specific game's matchmaking, Valorant/Overwatch/Blizzard internals, and the Riot *Persistence* post's contents (read only in a search summary).
- Labelled industry pattern: ticket contents, widening windows, party rules, ready check, backfill and reconnect design, warm-fleet sizing, and the end-to-end architecture sketch.
