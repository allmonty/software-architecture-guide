# P14 — Multi-tenancy: sharing a system between customers without sharing their problems

*A primer on serving many customers (tenants) from one system. The vocabulary and the isolation guidance come from AWS's SaaS Architecture Fundamentals whitepaper (2022); the tenancy models and the noisy-neighbour mitigations from Microsoft's Azure Architecture Center; a real shared-schema design from Salesforce's platform architecture brief; the decision method is our reasoning and is labelled. It describes SaaS-style tenancy, where the customers are organizations or accounts, not the physics of virtual machines sharing a host.*

## At a glance

A **tenant** is a customer (or a group of users treated as one customer) whose data and configuration must be kept apart from every other tenant's. **Multi-tenancy** means several tenants share some or all of the infrastructure, which makes the system cheaper to run and update than one deployment per customer. It also creates three standing problems: **isolation** (tenant A must never reach tenant B's data), the **noisy neighbour** (tenant A's load must not degrade tenant B), and **per-tenant operations** (cost, metrics, limits, upgrades, and moving a tenant between tiers). The sources treat the sharing level as a spectrum from fully dedicated to fully pooled, and a business decision as much as a technical one.

**In 60 seconds:** decide what a tenant is, then decide per layer (compute, data, network) whether it is shared or dedicated, by compliance, cost and noisy-neighbour needs, not by habit. Isolation is its own mechanism: authenticating a user does not stop that user reading another tenant's rows. Put the tenant identity in every request and every query path, enforce it below the application code where you can, limit each tenant's use of shared resources, and measure cost and load per tenant from day one.

---

## 1. What a tenant is, and how much to share `[CONFIRMED]` (Azure Architecture Center; AWS)

Azure starts with the definition problem: for business customers a tenant usually maps to the customer, but a customer may need several tenants (divisions, or separate development and production instances); for consumers a tenant might be a person, a family or a club. It insists that "Selecting a tenancy model isn't only a technical decision. It's also a commercial decision.", weighing business objectives, compliance, scale, automation capacity and SLAs. The trade-off is stated plainly: "If you expect your business to scale to a large number of customers, it's important to deploy shared infrastructure." A fully shared deployment is appealing because "operating a solution that has shared components is less expensive than using individual resources for each tenant", while dedicated stacks per tenant are the other extreme, where "cost efficiency is low because you don't share infrastructure among your tenants" but data is isolated and tenants are unlikely to affect each other.

Azure's models sit between the extremes: **vertical partitioning** mixes shared and dedicated deployments (most customers on shared infrastructure, dedicated for those who need more performance or isolation, or a deployment per geography); **horizontal partitioning** shares some layers and dedicates others (one application tier with a database per tenant); and the **Deployment Stamps** pattern replicates a whole unit of the system and assigns tenants to stamps. And "Instead of viewing isolation as a discrete property, consider it a spectrum": different components can be more or less isolated in the same architecture. AWS's vocabulary for the data layer is the pair **silo** and **pool**: "In a siloed model, you have a distinct storage construct for each tenant with no co-mingled data", and in pooled partitioning the data "is co-mingled and partitioned based on a tenant identifier that determines which data is associated with each tenant". Its DynamoDB example: a table per tenant is silo; the tenant identifier in the partition key of a shared table is pool. Mixing the two (silo some tenants or some data, pool the rest) is the practical middle; Azure's partitioned models above are that idea at the deployment level.

## 2. Isolation is not authentication `[CONFIRMED]` (AWS)

AWS makes the central point in one page: "SaaS systems include explicit mechanisms that ensure that each tenant's resources—even if they run on shared infrastructure—are isolated." And: "the fact that a tenant user is authenticated does not mean that your system has achieved isolation." Authentication and authorization give security, but "a user could be authenticated and authorized, and still access the resources of another tenant." Isolation uses the **tenant context** of the current request to decide which resources are reachable, for all users in that tenant, and it must hold whether the tenant has its own stack (coarse network policies) or shares pooled resources such as table items (fine-grained policies). A second distinction: "Partitioning data does not ensure that the data is isolated." How you store tenant data and how you prevent cross-tenant access are separate decisions, though the first influences the second. Our reading `[INDUSTRY PATTERN]`: the common failure is a missing tenant filter in one query path; so carry tenant identity from the edge in every call, build it into the data-access layer so a query cannot be written without it, and test cross-tenant access explicitly. In the atlas, [23 RAG assistant](../systems/23-rag-knowledge-assistant.md) shows the same rule for documents: retrieval must filter by permission, not only the interface. For security more broadly see [P06](P06-security-threat-modeling.md).

## 3. One shared schema, in practice `[CONFIRMED]` (Salesforce)

Salesforce's platform brief describes the far end of pooling: "A single shared multitenant database with a single schema that stores tenant-specific metadata and data", with a runtime that reads metadata to provide each tenant's customised application. Customisation is stored as metadata, so "the platform does not create an actual table in a database or compile any code" when a tenant defines an object. Privacy rests on an identifier: "every org-specific record in shared database tables has an OrgID", and "When the kernel accesses the database, it uses this unique identifier to ensure that each org's activities are private." The same brief describes the protection against one tenant hurting the rest: "To prevent malicious or unintentional monopolization of shared, multitenant system resources, the platform has an extensive set of governors and resource limits associated with platform code execution", covering CPU time, memory, query counts and outbound calls, and queries the optimizer judges too expensive "throw a runtime exception to the caller". The brief is a vendor's own description, undated as read; it shows one working design, not the only one.

## 4. The noisy neighbour `[CONFIRMED]` (Azure Architecture Center)

"The noisy neighbor problem occurs when one tenant's performance is degraded because of the activities of another tenant." It happens with one heavy tenant and also when many small tenants peak together. The Azure antipattern page is frank that "Sharing a single resource inherently carries the risk of noisy neighbor problems that you can't completely avoid", and lists what providers can do: monitor overall and per-tenant usage with alerts, **apply resource governance** (quotas through throttling or rate limiting), provision more capacity (more shards or stamps), let tenants buy reserved capacity, rebalance tenants across instances (placing complementary usage patterns together to flatten peaks), move non-urgent heavy work off-peak, restrict operations (a maximum returned record count or query time), and offer a quality-of-service tiering. The horizontal partitioning model above is itself a mitigation: dedicate the component that carries most of the load. Salesforce's governor limits are the same idea built into the platform. Our reading `[INDUSTRY PATTERN]`: per-tenant limits belong at several layers (API rate, concurrency, query cost, background-job share), and the limits themselves are a product decision, which is why they usually follow tiers. [02 Rate limiter](../systems/02-rate-limiter.md) covers the per-user mechanisms, and [P07](P07-slos-and-incidents.md) the load-shedding side.

## 5. Running it per tenant `[INDUSTRY PATTERN]`

Our reasoning, with the sources' hints:

- **Cost.** In a pooled system you cannot see cost per tenant unless you measure usage per tenant; Azure lists tracking and associating costs to tenants as a risk of the shared model. See [P08](P08-cost-as-a-design-input.md).
- **Metrics and SLOs.** Tag every metric and log with the tenant, so one tenant's outage or slowness is visible and one large tenant does not hide inside an average. Decide whether SLOs are per tenant tier.
- **Blast radius and releases.** A shared deployment is simpler to update but, as Azure notes, "also often riskier because changes might affect your entire customer base"; stamps let you roll out progressively. Compare with the complexity argument in [P11](P11-monolith-vs-microservices.md), where Fowler lists multi-tenancy among the sources of complexity.
- **Moving tenants.** Design the identifier so a tenant can be moved from the pool to a dedicated stack (or between stamps) without rewriting its data model.
- **Limits of the platform.** Shared infrastructure meets platform scale limits sooner (Azure: you are "more likely to reach Azure resource scale limits when you have a shared set of infrastructure"); plan sharding or stamps early.

## 6. A way to choose `[INDUSTRY PATTERN]`

| Situation | Leans toward |
|---|---|
| Many small customers, tight cost, similar usage | Pooled compute and data, tenant id everywhere, strict per-tenant limits |
| A few large customers with compliance or performance demands | Dedicated stacks (or dedicated data stores) for them, pooled for the rest |
| One component carries most of the load | Dedicate or shard that component first (horizontal partitioning) |
| Customers in different jurisdictions | Deployment per region (stamps), tenants mapped to a region |
| Early product, unknown tenant mix | Keep tenant identity in the data model from the start, and defer the expensive isolation until a customer needs it |

---

## Questions to practise

1. Define silo, pool and a mixed model for the data layer, with an example for a key-value store.
2. Why does authenticating a user not give tenant isolation? What does isolation add?
3. Give two ways a pooled system can leak data between tenants despite correct authentication.
4. What is the noisy-neighbour problem, and what are four mitigations?
5. How would you let one large customer move from the shared pool to its own stack?
6. What would you measure per tenant, and why?
7. Why is the tenancy model "a commercial decision" as well as a technical one?

## Practice

Take an atlas system that serves many customers, such as [23 RAG assistant](../systems/23-rag-knowledge-assistant.md) or [02 Rate limiter](../systems/02-rate-limiter.md), and design its tenancy: define a tenant, choose shared or dedicated for compute, data and the cache, state where the tenant identity is enforced, write the per-tenant limits you would set, and list what you would measure per tenant. Then name the one failure you would test first (for example a query path without the tenant filter) and how.

---

## Sources and provenance

> **Sources read on 2026-10-27:** AWS, [*SaaS Architecture Fundamentals*](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/saas-architecture-fundamentals.html) (published 3 August 2022; the whitepaper carries a "historical reference only" notice), the pages [Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html) and [Data partitioning](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/data-partitioning.html), and the [SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html) introduction · Microsoft Azure Architecture Center, [*Tenancy models for a multitenant solution*](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models) and the [*Noisy Neighbor antipattern*](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/noisy-neighbor/noisy-neighbor) (undated pages, read as served) · Salesforce Architects, [*Platform Multitenant Architecture*](https://developer.salesforce.com/wiki/multi_tenant_architecture) technical brief (undated; read as served) · Martin Fowler, [*Microservice Premium*](https://martinfowler.com/bliki/MicroservicePremium.html) (13 May 2015), for the one remark cited in section 5.
> **Dated material:** the AWS paper is from 2022 and marked historical; the Azure and Salesforce pages are revised without dates; the concepts are stable, the product names are not.
> **Not read:** AWS's longer *SaaS Tenant Isolation Strategies* paper and the rest of the SaaS Lens, the Azure overview and checklists, the Weissman and Bobrowski SIGMOD 2009 paper on the Force.com platform (the ACM page was not fetchable), row-level security features of specific databases, and any measured data on tenant-isolation failures. The advice to tie limits to tiers and to carry the tenant identity in every call is our reasoning.
> **Tags:** `[CONFIRMED]` stated by a primary source we read · `[INDUSTRY PATTERN]` standard practice or our reading of the sources · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the AWS pages: the definition of tenant isolation, the distinction from authentication and authorization, the definitions of silo and pool partitioning and the DynamoDB example, and the statement that partitioning does not ensure isolation.
- Verified in the Azure tenancy-models page: the definition problem for B2B and B2C tenants, the commercial-decision wording, the shared-versus-dedicated cost trade-offs, vertical and horizontal partitioning and stamps, the isolation-as-a-spectrum wording, and the risks of the shared model.
- Verified in the Azure noisy-neighbour page: the definition, the unavoidable-risk statement and the provider mitigations.
- Verified in Salesforce's brief: the single shared schema, metadata-driven customisation, the OrgID mechanism, and the governors and resource limits.
- Not claimed: how any one company isolates tenants today; any figure for the cost of a tenancy model; that a mitigation works as well in your system.
- Our reasoning, not from the sources: the "Our reading" sentences, the pointers to atlas notes, section 5, and the table in section 6.
