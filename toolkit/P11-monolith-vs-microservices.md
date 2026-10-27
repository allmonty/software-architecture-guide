# P11 — Monolith or microservices: choosing a deployment shape

*A primer on one of the most argued architecture decisions. The definitions and the cost argument come from Fowler and Lewis (2014) and Fowler's two short follow-ups (2015); the evidence comes from two companies' own accounts, Shopify (2019) and Prime Video (2023); the decision method is our reasoning and is labelled. It does not say which style is better. Both sources and companies say it depends.*

## At a glance

A **monolith** is one deployable unit; a **microservice architecture** splits one application into many small services that are deployed independently. The split buys independent deployment and scaling, and a boundary that is explicit (Fowler and Lewis note that many people believe it decays less than a monolith, though they say it is too early to be sure). It costs a distributed system: network calls, partial failure, data spread over many stores, and the tooling to deploy and observe all of it. Fowler calls that cost the **microservice premium** and says it pays off only when the system is complex enough. Two public accounts show the choice going either way: Shopify kept one codebase and set out to enforce boundaries inside it (a **modular monolith**), and a Prime Video monitoring team folded a distributed design back into one process and cut infrastructure cost by over 90%.

**In 60 seconds:** start from the problem, not the style. Ask what is actually hurting: a codebase too tangled to change, deployments that block each other, one part that needs to scale alone, or teams that cannot work in parallel. Fix boundaries first (modules with enforced interfaces and owned data), because services only work well on top of good boundaries. Split out a service when a specific need (independent scaling, independent release cadence, a team boundary) outweighs the operating cost, and not before.

---

## 1. What the two styles are `[CONFIRMED]` (Fowler and Lewis, 2014; Shopify, 2019)

Fowler and Lewis define the microservice style as "an approach to developing a single application as a suite of small services, each running in its own process". They add that "These services are built around business capabilities and independently deployable by fully automated deployment machinery." Shopify, quoting Simon Brown, defines the contrasting term: "A modular monolith is a system where all of the code powers a single application and there are strictly enforced boundaries between different domains." Our reading `[INDUSTRY PATTERN]`: the useful axes are separate: **how many deployment units** (one or many) and **how strict the boundaries are** (enforced or by convention). A monolith with no enforced boundaries and a set of services that share one database are both on the bad end of the second axis.

## 2. The cost side: the microservice premium `[CONFIRMED]` (Fowler, 2015; Fowler and Lewis, 2014)

Fowler's 2015 note says microservices bring costs of their own: "you have to work on automated deployment, monitoring, dealing with failure, eventual consistency, and other factors that a distributed system introduces", and that this premium "can slow down your development considerably" when the system is not complex enough to need them. His guideline is blunt: "don't even consider microservices unless you have a system that's too complex to manage as a monolith". He adds "The majority of software systems should be built as a single monolithic application." and that "Many of the problems ascribed to monoliths aren't essential to that style."

Three costs come up in the sources:

- **Boundaries are harder to move.** Fowler and Lewis: when components are services, "refactoring is much harder than with in-process libraries". A wrong boundary is cheap to fix in one codebase and expensive across services.
- **Data and transactions.** "Distributed transactions are notoriously difficult to implement", so services settle for eventual consistency. The patterns for living with that are in [P03](P03-distributed-transactions.md).
- **Availability multiplies.** With many synchronous calls in a chain, "the downtime of your system becomes the product of the downtimes of the individual components" (in plain terms, availabilities multiply, so a chain of ten services that are each 99.9% available is about 99.0% available).

The sources also stress that the word microservice covers very different sizes: Fowler has "seen microservice systems vary from a team of 60 with 20 services to a team of 4 with 200 services", and says it is not clear how much service size changes the premium.

## 3. Should you start with a monolith? `[CONFIRMED]` as Fowler's observation, not a law

Fowler's *MonolithFirst* note reports a pattern: "Almost all the successful microservice stories have started with a monolith that got too big and was broken up", while in nearly all the cases he knows of a system built as microservices from scratch, "it has ended up in serious trouble". His reasons are that you do not yet know if the product is useful (so speed matters more than the premium), and that stable service boundaries are hard to draw before the domain is understood. He is open about the limits: "it is by no means unanimous" (the counter-argument is that starting with services builds the habit), and "You cannot assume that you can take an arbitrary system and break it into microservices", because most systems acquire too many dependencies between modules to be split sensibly. He lists other routes: peel services off at the edges, build a monolith meant to be discarded, or start with a few coarse services. This is one practitioner's observation from the stories he has heard, not a measured result.

## 4. Two companies, two answers

**Shopify chose a modular monolith `[CONFIRMED]`** (blog post, 21 February 2019). Shopify describes "one of the largest Ruby on Rails codebases in existence", built as a monolith. By 2016 the downsides outweighed the benefits: "The application was extremely fragile with new code having unexpected repercussions", tests were slow, and new developers needed too much context. They considered microservices and weighed their costs (more pipelines and infrastructure, network calls that add latency and decrease reliability with every call, harder cross-service refactors). Their choice: "We chose to evolve Shopify into a modular monolith, meaning that we would keep all of the code in one codebase, but ensure that boundaries were defined and respected between different components." Each component got "a clean dedicated interface with domain boundaries expressed through a public API and took exclusive ownership of its associated data", and an in-house tool tracked boundary violations. The post says isolation was still in progress: enforcing boundaries in code was a plan, not a result. The post is from 2019, so what Shopify does now is not claimed here.

**A Prime Video team consolidated one service `[CONFIRMED]`** (engineering post, 22 March 2023). The team's audio/video quality monitoring tool was first built as distributed components orchestrated by AWS Step Functions with AWS Lambda, "a good choice for building the service quickly". It hit "a hard scaling limit at around 5% of the expected load". Step Functions was both the bottleneck and a cost (it charges per state transition, and the service made several per second of each stream), and passing video frames between components through Amazon S3 added many costly calls. They packed the components into a single process on EC2 and ECS, which removed the intermediate storage, and report: "Moving our service to a monolith reduced our infrastructure cost by over 90%." The trade-off they name: detectors now scale only vertically inside one instance, so when capacity ran out they cloned the service, each copy running a subset of the detectors, behind a lightweight request-distributing layer. Their takeaway is the point of this primer: whether to use microservices or serverless components "has to be made on a case-by-case basis".

**Our reading (`[INDUSTRY PATTERN]`, not from the sources):** neither account says microservices are bad. Shopify's problem was missing boundaries; the post reports that its isolation work was already paying off (it could swap out its tax engine) while calling complete isolation an ongoing task. Prime Video's was a particular design (per-second orchestration state transitions and bulk data passed through object storage) at a particular scale; it is one service, not the company. Read them as examples of choosing the shape per problem, which is what both sources conclude.

## 5. Teams and boundaries: Conway's law `[CONFIRMED]` (Conway, 1968)

Melvin Conway's paper states the thesis: "organizations which design systems (in the broad sense used here) are constrained to produce designs which are copies of the communication structures of these organizations." Fowler and Lewis use it to argue for splitting teams around business capabilities so that services follow. Our reading `[INDUSTRY PATTERN]`: service boundaries are also team boundaries, so a service split that does not match who owns what will tend to be undone by communication, and a team split that does not match the code will produce awkward interfaces. This is the strongest reason to split that is not about technology.

## 6. A way to decide `[INDUSTRY PATTERN]`

This is our reasoning, a checklist and not a rule from any source.

| Signal | Leans toward |
|---|---|
| One small team, product still being found | One deployable unit |
| Code is tangled, changes break distant tests | First, enforced module boundaries (even in one unit); services later if still needed |
| One component needs very different scaling, hardware or release cadence | Pull that component out as a service |
| Many teams blocked on one release train | Split along team and capability lines |
| No automated deploy, monitoring or on-call practice yet | Stay with fewer, larger units until you have them |
| Components exchange large data or call each other many times per request | Keep them in one process (Prime Video's case) |
| A migration is needed | Strangler fig, see [P10](P10-changing-systems-safely.md) |

Costs follow the shape: see [P08](P08-cost-as-a-design-input.md) for treating cost as a design input and [P07](P07-slos-and-incidents.md) for the failure behaviour you take on with every network call. In the atlas, [09 Discord](../systems/09-discord.md) describes data services placed between an API monolith and its databases, and [P03](P03-distributed-transactions.md) covers the consistency patterns that distributed services need.

---

## Questions to practise

1. What are the two independent axes in the monolith-or-microservices question, and where does a modular monolith sit?
2. List three costs of microservices that a monolith does not have, with the failure each causes.
3. Why does Fowler argue boundaries are harder to get right in services than in modules?
4. What did Shopify change, what did it keep, and what problem did that solve?
5. Why did consolidating one service cut Prime Video's cost, and what scaling limit did it accept in return? Why is that not an argument against microservices in general?
6. How does Conway's law affect where you cut a service boundary?
7. A team of six runs one product on a single codebase and wants to move to microservices "to scale". What do you ask first?

## Practice

Take one atlas system with several containers (for example [13 Netflix](../systems/13-netflix.md) or [09 Discord](../systems/09-discord.md)). For each container say whether you would deploy it separately, using only the signals in section 6. Then argue the opposite for the one you were surest about, and write down what evidence would change your mind (a measured scaling limit, a team boundary, a release-cadence conflict).

---

## Sources and provenance

> **Sources read on 2026-10-27:** James Lewis and Martin Fowler, [*Microservices*](https://martinfowler.com/articles/microservices.html) (25 March 2014) · Martin Fowler, [*MonolithFirst*](https://martinfowler.com/bliki/MonolithFirst.html) (3 June 2015) and [*Microservice Premium*](https://martinfowler.com/bliki/MicroservicePremium.html) (13 May 2015) · Kirsten Westeinde, [*Deconstructing the Monolith*](https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity) (Shopify Engineering, 21 February 2019) · Marcin Kolny, [*Scaling up the Prime Video audio/video monitoring service and reducing costs by 90%*](https://www.primevideotech.com/video-streaming/scaling-up-the-prime-video-audio-video-monitoring-service-and-reducing-costs-by-90) (22 March 2023; the original page now redirects, so we read the [Internet Archive copy](https://web.archive.org/web/2023/https://www.primevideotech.com/video-streaming/scaling-up-the-prime-video-audio-video-monitoring-service-and-reducing-costs-by-90)) · Melvin Conway, [*How Do Committees Invent?*](http://www.melconway.com/Home/Committees_Paper.html) (Datamation, April 1968).
> **Dated material:** the definitions are from 2014 and the evidence from 2019 and 2023; what Shopify and Prime Video do today is not claimed.
> **Not read:** Shopify's later tooling and writing on modular monoliths, any measurement of microservice vs monolith productivity (the sources are practitioners' accounts, not studies), Sam Newman's and other book-length treatments, and Amazon's other architecture posts.
> **Tags:** `[CONFIRMED]` stated by a primary source we read · `[INDUSTRY PATTERN]` standard practice or our reading of the sources · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in Fowler and Lewis: the definition of the microservice style, the business-capability and independent-deployment wording, the refactoring cost, the distributed-transactions remark, the multiplied downtime, and the Conway's-law framing.
- Verified in Fowler's two notes: the premium wording, the guideline and the "majority" sentence, the 60-versus-4 team example, the monolith-first observation and its stated limits (not unanimous, cannot assume a system can be split), and the alternative routes.
- Verified in Shopify's post: the codebase description, the 2016 tripwires, the choice of a modular monolith and its definition, the component interface and data ownership, the in-house boundary tool, and that enforcement was still planned.
- Verified in the Prime Video post: the architecture before and after, the Step Functions and S3 cost and scaling causes, the 5% limit, the over 90% figure, the vertical-scaling trade-off and the cloned-service workaround, and the case-by-case conclusion.
- Verified in Conway's paper: the thesis sentence in its conclusion.
- Not claimed: how Shopify or Prime Video operate now; any claim that one style is better; that Prime Video's result transfers to other systems.
- Our reasoning, not from the sources: the "Our reading" paragraphs, the Conway's-law application, and the decision table in section 6.
