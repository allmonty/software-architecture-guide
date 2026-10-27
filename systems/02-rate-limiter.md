# 02 — Rate Limiter

> **Kind:** mostly real-system. Stripe, Cloudflare and Envoy each document how they limit requests, and the claims below are tied to those texts. The combined "interview design" at the end is a synthesis `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** [Stripe, *Scaling your API with rate limiters*](https://stripe.com/blog/rate-limiters) (2017) · [Cloudflare, *Counting things, a lot of different things*](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) · Envoy docs: [global rate limiting](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting) and [rate limit filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/rate_limit_filter) · [Redis `INCR`](https://redis.io/docs/latest/commands/incr/) (rate limiter pattern) · [IETF RateLimit headers draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/).
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice, no single authority · `[SPECULATIVE]` plausible design choice.

---

## 🧒 Non-technical explanation

A rate limiter is a **bouncer with a clicker**. Everyone gets a fixed allowance, say 10 entries a minute. Once a guest has used up theirs, the bouncer says "come back later" instead of letting them crowd out everyone else.

The interesting questions are all about the clicker:
- Does the allowance **refill smoothly** (a bucket that drips full) or **reset on the minute** (a turnstile that clicks to zero)?
- With **many doors** open at once, how do the bouncers share one count without phoning each other on every guest?
- If the clicker **breaks**, do they let everyone in or nobody? Most pick "everyone", because a broken clicker should not close the club.

---

## TL;DR for engineers

- **Rate limiting is not one thing.** Stripe runs four mechanisms with different jobs: a per-user request rate limiter, a concurrent-requests limiter, and two load shedders that protect the fleet `[CONFIRMED]` (Stripe).
- **Token bucket** is Stripe's request limiter. It allows short bursts above the steady rate `[CONFIRMED]`. **Sliding-window counter** is Cloudflare's approach: weight the previous window's count by how much of it still overlaps `[CONFIRMED]`.
- **State is in a shared fast store** (Redis for Stripe `[CONFIRMED]`, memcached-protocol for Cloudflare `[CONFIRMED]`) and the operations need to be **atomic**. Redis documents the INCR+EXPIRE race and the Lua fix `[CONFIRMED]`.
- **Fail open** is the norm: Stripe catches errors so the API stays up `[CONFIRMED]`. Envoy's filter can be configured either way (`failure_mode_deny`) `[CONFIRMED]`.
- **Dark launch** each limiter and keep a kill switch before enforcing `[CONFIRMED]` (Stripe).
- **Tell the client**: return `429` (RFC 6585) and a back-off hint. The IETF `RateLimit` header draft is still an active Internet-Draft, not a standard `[CONFIRMED]`.

---

## 1. Requirements

**Functional:** limit by a key (API key, user, IP, route). Reject over-limit requests with a clear status. Allow configurable limits per key and per route. Optionally allow bursts.

**Non-functional:** adds **single-digit milliseconds** to the request path `[SPECULATIVE]` (a typical target, not a sourced number) · available even when the limiter's own store fails · accurate enough (see Cloudflare's measured error below) · low memory per key · hard to evade by changing identity.

**Clarifying questions to ask:** what is the key (user, IP, API key, tenant)? Hard or soft limit? One region or global? Is a small overshoot acceptable? What should happen when the limiter is down?

---

## 2. The four mechanisms Stripe documents `[CONFIRMED]`

| Mechanism | What it limits | Notes from the post |
|---|---|---|
| **Request rate limiter** | Requests per second per user | Called "by far the most important one". Token bucket. Allows brief bursts (e.g. flash sales) |
| **Concurrent requests limiter** | In-flight requests per user | For expensive endpoints, e.g. "20 API requests in progress at the same time" |
| **Fleet usage load shedder** | Non-critical traffic when the fleet is busy | Reserves a share of capacity for critical methods. Redis counts requests by type. Rejects with 503 |
| **Worker utilization load shedder** | Traffic categories when workers are saturated | "Final line of defense" during incidents. Sheds test-mode traffic first, then in a fixed order |

**Why it matters in an interview:** the answer to "design a rate limiter" is stronger if you separate **fairness** (per-user limits) from **protection** (load shedding). Different goals, different keys, different failure behaviour.

Stripe's rollout advice, all from the same post `[CONFIRMED]`: start with the request rate limiter and add the rest as scale demands. Dark-launch each limiter to see what it would block. Keep feature-flag kill switches. Catch exceptions at every level so bugs fail open.

---

## 3. Algorithms compared

| Algorithm | How it counts | Strength | Weakness | Primary source |
|---|---|---|---|---|
| **Fixed window counter** | One counter per key per window (e.g. per second), `INCR` + `EXPIRE` | Trivial, O(1), tiny memory | A burst straddling a window boundary can pass up to ~2× the limit `[INDUSTRY PATTERN]` | Redis `INCR` docs describe this pattern `[CONFIRMED]` |
| **Sliding window counter** | `rate = previous × (window − elapsed)/window + current` | Smooth, O(1), two counters per key | An approximation | Cloudflare `[CONFIRMED]` |
| **Sliding window log** | Store a timestamp per request, count those in the window | Exact | Memory grows with the limit | `[INDUSTRY PATTERN]` |
| **Token bucket** | Bucket refills at a steady rate. Each request takes a token. Empty = reject | Allows bursts up to the bucket size, steady long-run rate | Two numbers to tune (rate, capacity) | Stripe, and Envoy's local limiter `[CONFIRMED]` |
| **Leaky bucket** | Queue drains at a fixed rate | Smooths output | Adds delay or drops, no burst allowance | `[INDUSTRY PATTERN]` |

### Cloudflare's worked example and measured accuracy `[CONFIRMED]`

Limit 50 requests/min, 18 requests so far in the current minute (started 15 s ago), 42 in the previous minute:

```
rate = 42 × ((60 − 15) / 60) + 18 = 49.5   → under the limit, allow
```

Across **400 million requests from 270,000 sources**, Cloudflare reports 0.003% of requests were wrongly allowed or limited, an average 6% gap between the real and approximate rate, **no false positives**, and 3 sources allowed while slightly over the threshold (by less than 15%). The post calls it "only an approximation".

### The Redis atomicity trap `[CONFIRMED]`

Redis's own docs show the simple pattern (`INCR`, then `EXPIRE` when the value is 1) and then state: **"In the above code there is a race condition."** If the client does the `INCR` but not the `EXPIRE`, the key leaks. The fixes they give: wrap it in `MULTI`/`EXEC`, or a **Lua script** sent with `EVAL`, or use lists instead of counters. Take-away: the check-and-update must be one atomic step on the store.

---

## 4. Where state lives, and how many nodes share it

| Design | How it works | Who documents it |
|---|---|---|
| **Central store (Redis)** | All app nodes call one Redis cluster for counters | Stripe `[CONFIRMED]` |
| **Per-site counters via anycast** | Anycast routes one IP to the same PoP, so each PoP counts alone, using Twemproxy + Twemcache (memcached protocol) with `GET`/`SET`/atomic `INCR`. Increments are asynchronous. A "mitigation" flag is stored once the threshold is exceeded and servers cache it locally until it ends | Cloudflare `[CONFIRMED]` |
| **Local + global in two stages** | Each Envoy proxy runs a local token bucket, then calls a **global gRPC rate-limit service**. The local bucket absorbs bursts so the global service is not overwhelmed | Envoy docs `[CONFIRMED]` |

Cloudflare avoided compare-and-swap because "during attacks, we will have a lot of requests, creating a lot of contention" `[CONFIRMED]`, a good example of choosing a primitive (`INCR`) that survives hot keys.

**Failure behaviour:**
- Stripe: any errors "fail open" so the API stays functional `[CONFIRMED]`.
- Envoy: with `failure_mode_deny` true, a failed call returns a **500**. When false, errored requests are allowed through (counted in `failure_mode_allowed`). The page doesn't spell out the default value, so check the filter reference before relying on it `[CONFIRMED]`.
- Cloudflare's post doesn't discuss fail-open vs fail-closed, so nothing is claimed here.

---

## 5. Responding to the client

- **429 Too Many Requests** is the usual status (RFC 6585). Envoy returns 429 when a descriptor is over limit, configurable with `rate_limited_status`, and sets `x-envoy-ratelimited` unless disabled `[CONFIRMED]`. Stripe uses 429 or 503 depending on the limiter `[CONFIRMED]`.
- **Back-off hints:** the IETF draft `draft-ietf-httpapi-ratelimit-headers` (version 11, an **active Internet-Draft**, expires 2026-11-24, no intended RFC status set as of the page read) defines `RateLimit-Policy` (the quota policy) and `RateLimit` (the current limit). If a response also has `Retry-After`, `Retry-After` takes precedence `[CONFIRMED]`. Because it is a draft, header names may change, and many services still ship vendor-specific `X-RateLimit-*` headers `[INDUSTRY PATTERN]`.

---

## 6. Interview design `[INDUSTRY PATTERN]`

```
client → edge / API gateway ──► local token bucket (per node, no network)
                         └────► shared counter store (atomic op) ──► allow / 429
                                          │
                              config service (limits per key / route, hot-reloaded)
```

1. **Gateway-level limiter** keyed by API key, falling back to IP. Per-route limits from a config service.
2. **Two stages:** a cheap local bucket first, then the shared store for the global count. This is Envoy's recommended shape `[CONFIRMED]`.
3. **Atomic update** in the store (Lua script or an atomic increment). Never read-then-write.
4. **Fail open** with an alert and a kill switch. Dark launch every new rule.
5. **Hot keys:** one abusive key can overload one shard. Cache the "already blocked" decision locally, as Cloudflare does with its mitigation flag `[CONFIRMED]`.

Capacity is not worked out here because it depends entirely on the assumed traffic. State the assumptions and derive them if asked: counters take bytes per key, so memory is rarely the issue. Store round-trips are.

---

## ⚠️ Reviewer notes

1. **Many tutorials present "token bucket vs leaky bucket vs sliding window" as the whole answer.** Stripe's post shows that production systems add concurrency limits and load shedding, and these matter as much as the per-user algorithm.
2. **Fixed-window counters are not "wrong".** Redis's documentation presents them as the standard pattern. The boundary-burst weakness is real but may be acceptable. Cloudflare moved to a sliding approximation because of its accuracy needs.
3. **Do not claim a rate limiter is exact across regions.** Cloudflare's design is deliberately per-PoP, and relies on anycast to keep one source in one PoP under normal conditions `[CONFIRMED]`. Global exactness would cost cross-region latency.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from a primary source. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (it sits on every request), **availability** (it must not be the thing that takes the API down), **scalability**. **Accuracy** is a secondary characteristic that you trade against cost.
- **Style (Ch 9–10):** an **interceptor in the request path** (gateway or sidecar) backed by a **shared state service**. Envoy's local-plus-global split is a concrete example.
- **Quanta (Ch 7):** the limiter and the API it protects are one quantum if the limiter fails closed. With **fail-open**, they become independently deployable and the limiter store can fail without the API failing.
- **Trade-off (First Law, Ch 1):** **accuracy vs latency/cost.** Sliding-window approximation (6% average gap, per Cloudflare) vs an exact log that costs memory and writes.
- **ADR sketch (Ch 19):** *"We will fail open if the counter store is unreachable, alert on it, and keep a kill switch. We accept that a store outage lets abusive traffic through for its duration."* (Same decision Stripe documents.)
- Plain English: a broken clicker should wave people in, not lock the club, and someone should be paged.

---

## Interview questions to practice

1. Token bucket vs sliding-window counter: when does each give a worse answer?
2. Two app servers both read the counter as 9 of 10 and both allow a request. Fix it.
3. A single customer sends 100k requests/s to one key. What breaks first, and what do you do about the hot shard?
4. The Redis cluster is down. What does the API do? Who gets paged?
5. How do you roll out a new, lower limit safely?
6. How would you make limits fair across a multi-region deployment?

## 📚 Further reading

- [Stripe: Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters)
- [Cloudflare: Counting things, a lot of different things](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
- [Envoy: Global rate limiting](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting) · [Rate limit filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/rate_limit_filter)
- [Redis: INCR (rate limiter pattern)](https://redis.io/docs/latest/commands/incr/)
- [IETF draft: RateLimit header fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (general background, secondary source)

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each primary source in full text during this session.* No claim was changed during checking. Three were softened (listed last). We did not keep a numeric tally of verified claims, so the list below names what was checked.
- Verified against Stripe's post: four limiters and their roles, token bucket, Redis, fail-open, dark launch, kill switches, 429/503, adoption order.
- Verified against Cloudflare's post: sliding-window formula and worked example (42×45/60+18 = 49.5, checked by hand), the 400M/270,000/0.003%/6%/3 sources/<15%/no-false-positives figures, Twemproxy+Twemcache, anycast per-PoP counting, async increments, mitigation flag, CAS avoided.
- Verified against Envoy docs: gRPC global service, local token bucket, two-stage recommendation, `failure_mode_deny` 500 behaviour, 429 and `x-envoy-ratelimited`.
- Verified against Redis `INCR`: both patterns, the stated race condition and the Lua/MULTI/list fixes.
- Verified against the IETF page: draft version 11, active, expires 24 Nov 2026, field names, `Retry-After` precedence.
- Softened: Envoy's default for `failure_mode_deny` is not stated on the page we read, so none is claimed.
- Softened: Cloudflare's fail-open behaviour is not in the post, so none is claimed.
- Softened: "single-digit milliseconds" latency target is labelled `[SPECULATIVE]`.
- Not sourced (marked `[INDUSTRY PATTERN]`): sliding window log, leaky bucket, fixed-window 2× burst bound.
- Caveat: the Stripe post is from 2017 and the figures it quotes ("this month") are from then. We use it for design, not for current numbers.
