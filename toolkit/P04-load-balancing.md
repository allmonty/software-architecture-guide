# P04 — Load balancing: L4, L7 and the algorithms

*A primer on spreading traffic across servers. Facts come from Google's Maglev paper and Envoy's documentation; the layer comparison and the decision guide are our reasoning and are labelled.*

## At a glance

A load balancer picks which server handles each connection or request. The key design questions are **at which layer** (packets and connections, or HTTP requests), **which algorithm** (round robin, least requests, consistent hashing), **how it learns about failures** (health checks), and **how the load balancer itself is made redundant and scaled**. Maglev (Google, L4) and Envoy (a proxy used at L7) document opposite ends of this space.

**In 60 seconds:** use an L4 balancer for raw throughput and connection-level distribution; use an L7 proxy when you need to route by path or header, retry, or balance per request. Pick least-request (power of two choices) for uneven request costs, consistent hashing when requests must stick to a server (caches, shards), and always pair any choice with health checks and slow start for new servers.

---

## 1. A network (L4) load balancer: Maglev `[CONFIRMED]` (Eisenbud et al., NSDI 2016)

Maglev is "Google's network load balancer", a distributed software system on commodity Linux servers: unlike traditional hardware balancers, it does not need a specialised rack deployment, and its capacity "can be easily adjusted by adding or removing servers". It has served Google's traffic since 2008 and also provides network load balancing for Google Cloud Platform. Key design points:
- **Scale-out through the network:** network routers spread packets evenly to the Maglev machines using Equal Cost Multipath (ECMP); each Maglev machine then matches packets to services and spreads them evenly across service endpoints. A single machine can saturate a 10 Gbps link with small packets.
- **Connection affinity:** for connection-oriented protocols such as TCP it is critical to send all packets of a connection to the same backend. Maglev first selects a backend with consistent hashing and then records the choice in a local connection tracking table, a fixed-size hash table keyed by the packet's 5-tuple hash. Connection tracking alone is not enough, because the router may send packets of one connection to a different Maglev machine (for example when machines change), so consistent hashing makes different machines choose the same backend.
- **Why not share connection state?** The paper notes that sharing state among all machines, for example in a distributed hash table, would hurt forwarding performance, so it prefers local consistent hashing with two properties: load balancing (backends get nearly equal numbers of connections) and minimal disruption (when the set of backends changes, a connection is likely to go to the same backend as before).
- **Maglev hashing:** a large lookup table in which each backend takes a number of entries.

## 2. An application (L7) proxy: Envoy `[CONFIRMED]` (Envoy documentation)

Envoy's cluster manager uses a pluggable **load balancing policy**, set per upstream cluster, to pick a host; if no active health checking is configured, all members are considered healthy unless otherwise specified. Documented policies:
- **Weighted round robin:** hosts are selected in rotation; weights make heavier hosts appear more often.
- **Client-side weighted round robin:** weights come from load reports (QPS, errors, utilization) sent by upstreams, with slow start so new or recovered endpoints ramp up.
- **Weighted (least) request:** with equal weights it picks N random available hosts (2 by default) and chooses the one with the fewest active requests. This is the power of two choices (P2C); the documentation says Mitzenmacher et al. showed it is nearly as good as a full O(N) scan and that it resists herding behaviour.
- **Ring hash:** consistent hashing on a ring of hosts (also known as Ketama), effective only when routing specifies a value to hash on.
- **Maglev:** consistent hashing using the algorithm in the Maglev paper, with a fixed table size of 65,537, usable as a drop-in replacement for ring hash.

## 3. Choosing `[INDUSTRY PATTERN]`

| Question | Guidance |
|---|---|
| L4 or L7? | L4 sees connections, not requests: very fast, protocol-agnostic, cannot route by URL or retry one request. L7 understands HTTP/gRPC: routing, retries, per-request balancing, observability, at more CPU cost. Large systems often use both: an L4 tier in front of an L7 fleet. |
| Requests of very different cost? | Least-request or P2C beats round robin, because it reacts to actual load. |
| Need a request to land on the same server (cache, shard, session)? | Consistent hashing on a key; accept that load follows key popularity (hot keys). |
| New or recovering servers? | Slow start, so they are not flooded before they warm up. |
| Failure detection | Active health checks plus passive outlier ejection; cap how much of the fleet can be ejected, to avoid ejecting everything at once (compare [C04 Facebook 2021](C04-facebook-2021.md)). |
| Who balances the balancers? | Spread traffic to the balancer tier with ECMP or DNS, and make balancers stateless or consistently hashed so any one can fail. |
| Geography | Route users to the nearest healthy region first (compare [13 Netflix](../systems/13-netflix.md) steering), then balance inside it. |

Atlas examples: [29 Live streaming](../systems/29-live-streaming-twitch.md) (ingest routing), [22 LLM inference serving](../systems/22-llm-inference-serving.md) (routing by load and prefix), [24 Vector search](../systems/24-vector-semantic-search.md) (scatter-gather).

---

## Questions to practise

1. Why can't a TCP load balancer just pick a random backend per packet?
2. What is the power-of-two-choices algorithm and why does it beat random assignment?
3. When do you want consistent hashing, and what goes wrong with it for a hot key?
4. How would you scale a load balancer tier beyond one machine?
5. What health checking would you use, and how do you avoid ejecting all backends at once?

## Practice

Draw the path of a request from a user to a service in a two-tier design (L4 then L7), mark where each decision is made, and list what happens when one machine at each tier fails.

**Related:** [13 Netflix](../systems/13-netflix.md), [22 LLM inference serving](../systems/22-llm-inference-serving.md), [29 Live streaming](../systems/29-live-streaming-twitch.md), [02 Rate limiter](../systems/02-rate-limiter.md).

## Sources and provenance

> **Sources read on 2026-10-27:** Eisenbud et al., [*Maglev: A Fast and Reliable Software Network Load Balancer*](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/44824.pdf) (NSDI 2016; PDF text extracted locally) · Envoy documentation, [Supported load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) (as of 2026-10-27, version 1.41-dev).
> **Dated material:** Maglev is from 2016; Envoy's documentation changes between releases.
> **Not read:** Cloud provider load balancer documentation (AWS, GCP, Azure), the Mitzenmacher power-of-two-choices paper, Maglev's performance sections in detail, and DNS-based balancing.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Maglev paper: the abstract's statements (commodity servers, ECMP, 10 Gbps, consistent hashing and connection tracking, in service since 2008), the 5-tuple connection tracking table, the reasons for local consistent hashing and the two properties.
- Verified in the Envoy page: the pluggable per-cluster policy, weighted and client-side round robin, the P2C description, ring hash, and Maglev with table size 65537.
- Not sourced (our reasoning): the choice table and the L4 versus L7 comparison.
