# P07 — Reliability for architects: SLOs, error budgets, cascading failures and postmortems

*A primer on how reliability targets are set and how failures are handled. Definitions and lessons come from chapters of Google's Site Reliability Engineering book; the arithmetic and the interview guidance are our reasoning and are labelled.*

## At a glance

Reliability is a design input with a price, not a goal to maximise. The vocabulary architects need: an **SLI** (a measurement of service level, such as the fraction of successful requests), an **SLO** (the target for that measurement), an **SLA** (a business agreement with consequences if missed) and an **error budget** (how much unreliability the SLO permits, spent on releases and risk). Failure handling adds two more ideas: stop **cascading failure** with load shedding, bounded retries and degradation, and learn from every incident through a **blameless postmortem**.

**In 60 seconds:** pick SLIs from what users care about, set SLOs a little below what users would notice, treat the gap to 100% as a budget that funds change, protect services from overload before they fall over, and write postmortems that fix systems instead of blaming people.

---

## 1. Why not 100%? `[CONFIRMED]` (Google SRE book, "Embracing Risk")

The chapter argues that "past a certain point, however, increasing reliability is worse for a service (and its users) rather than better": extreme reliability limits how fast features can be developed, dramatically raises cost, and users typically do not notice the difference between high and extreme reliability because their experience is dominated by less reliable components such as the cellular network or the device.

**Error budgets** resolve the tension between product teams (rewarded for velocity) and reliability teams (rewarded for stability). The two teams "jointly define a quarterly error budget based on the service's service level objective"; the budget "provides a clear, objective metric that determines how unreliable the service is allowed to be within a single quarter", removing "the politics from negotiations" about how much risk to allow, and error budgets "make it easier to decide the rate of releases".

## 2. SLIs, SLOs and SLAs `[CONFIRMED]` (SRE book, "Service Level Objectives")

- An SLI should directly measure a service level of interest, though sometimes only a proxy is available (server-side latency when client-side latency is what users feel). **Availability** is often defined as the fraction of well-formed requests that succeed; for storage systems **durability** matters equally.
- "Start by thinking about (or finding out!) what your users care about, not what you can measure." Working backwards from desired objectives to indicators often works better than the reverse. An SLO should state how it is measured and the conditions under which it is valid.
- Guidance on targets: "don't pick a target based on current performance" (it can lock you into heroic efforts); keep SLIs simple, because complicated aggregations obscure changes; avoid absolutes; have as few SLOs as possible ("if you can't ever win a conversation about priorities by quoting a particular SLO, it's probably not worth having that SLO"); and start loose and tighten, because "perfection can wait".
- Choosing targets "is not a purely technical activity" because of product and business implications.
- SLAs add consequences: "crafting an SLA requires business and legal teams to pick appropriate consequences and penalties for a breach"; the book advises being conservative in what you advertise and notes that people who talk about an "SLA violation" usually mean a missed SLO.

**Availability arithmetic `[INDUSTRY PATTERN]` (our calculation).** In a 30-day month (43,200 minutes), 99% allows about 432 minutes of unavailability, 99.9% about 43 minutes, 99.99% about 4.3 minutes, and 99.999% about 26 seconds. Each extra nine costs disproportionately more, and a serial chain of dependencies multiplies availabilities: three components at 99.9% each give roughly 99.7% together.

## 3. Cascading failures `[CONFIRMED]` (SRE book, "Addressing Cascading Failures")

The chapter defines a cascading failure as "a failure that grows over time as a result of positive feedback": for example, one replica fails from overload, which increases load on the remaining replicas and their probability of failure, "causing a domino effect that takes down all the replicas for a service".

Mechanisms and defences it discusses:
- **Load shedding** drops some proportion of load as the server approaches overload, so it does not run out of memory, fail health checks or serve with extreme latency while still doing as much useful work as it can; per-task throttling by CPU, memory or queue length is one form.
- **Graceful degradation**: decide which metrics trigger it, what the degraded mode does, and at which layer it is implemented.
- **Retries** deserve care. The chapter's example is a frontend that retries a failed backend call up to 10 times per logical request; under overload this multiplies the load. (Our guidance: cap retries, use exponential backoff with jitter, and use retry budgets.)
- **Rate limiting** can be done at reverse proxies, load balancers and other layers, indiscriminately or selectively (see [02 Rate limiter](../systems/02-rate-limiter.md)).

Incidents in the casebook show cascades: [C06 AWS Kinesis 2020](C06-aws-kinesis-2020.md) (dependency chains and slow restarts) and [C02 Cloudflare 2019](C02-cloudflare-2019.md) (CPU exhaustion everywhere at once).

## 4. Postmortems `[CONFIRMED]` (SRE book, "Postmortem Culture")

The primary goals are "to ensure that the incident is documented, that all contributing root cause(s) are well understood, and, especially, that effective preventive actions are put in place to reduce the likelihood and/or impact of recurrence." A postmortem must be blameless: it focuses on contributing causes "without indicting any individual or team", assuming "everyone involved in an incident had good intentions and did the right thing with the information they had". Otherwise, "people will not bring issues to light for fear of punishment". The chapter notes blameless culture originated in healthcare and avionics, and that postmortems are expected after significant undesirable events while being deliberate about when to write one because of the cost.

**What an architect adds `[INDUSTRY PATTERN]`:** for each incident, ask what the architecture allowed (blast radius, hidden dependencies, missing limits), not only what the person did, and turn the answer into a design change with an owner and a date.

## 5. Using this in a design discussion `[INDUSTRY PATTERN]`

1. Name the user-visible SLIs (success rate, latency percentile, freshness) and propose SLOs with rationale.
2. Show how the design meets them: redundancy, timeouts, retries with budgets, overload protection, degradation.
3. State the dependency chain and its combined availability.
4. Say what you would alert on (symptoms against the SLO) and how you would respond (runbooks, rollbacks).
5. Describe how you would learn: postmortems and game days (see the drills Meta describes in [C04](C04-facebook-2021.md)).

---

## Questions to practise

1. What is the difference between an SLI, an SLO and an SLA?
2. Why would you deliberately not aim for 100% availability?
3. How does an error budget change the conversation between product and operations?
4. A service is overloaded and its replicas are failing one by one. What do you do first, and what design would have prevented it?
5. Write the blameless summary of an outage in which an engineer ran the wrong command.

## Practice

Choose two systems from the atlas. For each, write three SLIs, an SLO for each, the error budget in minutes per month, and the one failure most likely to burn the budget.

**Related:** [02 Rate limiter](../systems/02-rate-limiter.md), [30 Metrics monitoring and alerting](../systems/30-metrics-monitoring-alerting.md), [C01 to C06 casebook](README.md), [P04 Load balancing](P04-load-balancing.md).

## Sources and provenance

> **Sources read on 2026-10-27:** Google, *Site Reliability Engineering* (O'Reilly, 2016; free online): [Embracing Risk](https://sre.google/sre-book/embracing-risk/), [Service Level Objectives](https://sre.google/sre-book/service-level-objectives/), [Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/) and [Postmortem Culture](https://sre.google/sre-book/postmortem-culture/).
> **Dated material:** The book is from 2016 and describes Google's practice; later editions and the SRE Workbook refine alerting on burn rates.
> **Not read:** The SRE Workbook (burn-rate alerting), Google's other SRE chapters (monitoring, release engineering, on-call), and incident-command frameworks.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the four chapters: the reliability-cost argument, error budget definition and effect, SLI/SLO/SLA guidance as quoted, the cascading-failure definition and example, load shedding, graceful degradation, retry example, rate limiting placement, and the postmortem goals and blameless principle.
- Not sourced (our reasoning): the availability arithmetic and the serial-chain example, retry-budget advice, the architect's postmortem questions, and the design-discussion checklist.
