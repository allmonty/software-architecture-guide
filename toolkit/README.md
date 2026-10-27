# Architect's toolkit

Material around the 35 system-design notes, for senior engineers preparing for interviews or for an architect role. Same rules as the atlas: primary sources only, claims tagged `[CONFIRMED]` / `[INDUSTRY PATTERN]` / `[SPECULATIVE]`, our own analysis labelled, and a verification log in every page. `npm run validate`, `verify`, `links` and `freshness` cover this folder too.

## Casebook: learning from real incidents (`C`)

Each page retells one published incident from the operator's own account, then asks the questions a design review could have asked. Read the incident, close the page, and write your own list of safeguards before you read the analysis.

| # | Incident | Main lessons |
|---|---|---|
| C01 | [Amazon S3, February 2017](C01-aws-s3-2017.md) | operator-tool blast radius, cold restarts of rarely restarted systems, status page dependencies |
| C02 | [Cloudflare, July 2019](C02-cloudflare-2019.md) | regex backtracking, unstaged global rule deploys, tests that miss resource use, locked-out responders |
| C03 | [GitHub, October 2018](C03-github-2018.md) | automated failover and split writes, data integrity versus availability, restore time |
| C04 | [Facebook, October 2021](C04-facebook-2021.md) | audit-tool bug, health rules that withdraw everything, recovery tools that depend on the failure |
| C05 | [Knight Capital, August 2012](C05-knight-capital-2012.md) | partial deployment, dead code and flag reuse, missing kill switch and exposure limits |
| C06 | [AWS Kinesis, November 2020](C06-aws-kinesis-2020.md) | resources that grow with fleet size, slow cold starts, dependency cascades |

## Primers: the cross-cutting topics (`P`)

Short sourced explainers for topics that recur across the atlas. Each ends with questions and a practice task.

| # | Primer | Sources |
|---|---|---|
| P01 | [Back-of-the-envelope estimation](P01-estimation.md) | Jeff Dean's latency table (2009), worked examples |
| P02 | [Choosing a storage engine](P02-storage-engines.md) | PostgreSQL and RocksDB documentation |
| P03 | [Distributed transactions: 2PC, sagas, outbox](P03-distributed-transactions.md) | Azure Architecture Center, sagas paper, Kafka docs |
| P04 | [Load balancing](P04-load-balancing.md) | Maglev paper, Envoy documentation |
| P05 | [API design: pagination, idempotency, evolution](P05-api-design.md) | Google AIPs, Stripe API reference |
| P06 | [Security for architects](P06-security-threat-modeling.md) | Threat Modeling Manifesto, OWASP, NIST SP 800-207 |
| P07 | [SLOs, error budgets, cascading failures, postmortems](P07-slos-and-incidents.md) | Google SRE book |
| P08 | [Cost as a design input](P08-cost-as-a-design-input.md) | AWS Well-Architected, FinOps Foundation |
| P09 | [Decisions: ADRs, design docs, boring technology](P09-decisions-and-design-docs.md) | Nygard, AWS, Google design docs, McKinley |
| P10 | [Changing systems safely](P10-changing-systems-safely.md) | Fowler, Azure Architecture Center |

## Workbook: practice with feedback (`W`)

Our own exercises, with answer keys that cite the sourced notes. Work them in this order.

| # | Page | Use |
|---|---|---|
| W01 | [Mock interview protocol and rubric](W01-mock-interview-protocol.md) | A 45-minute script and an 8-row scoring rubric |
| W02 | [Find the flaw](W02-find-the-flaw.md) | Nine flawed designs with answer keys |
| W03 | [Estimation drills](W03-estimation-drills.md) | Eight capacity problems with worked solutions |
| W04 | [Decision exercises](W04-decision-exercises.md) | Six scenarios that ask for an ADR |
| W05 | [Flashcards](W05-flashcards.md) | 58 cards for spaced repetition |

## Suggested order

1. Skim the primers you are weakest on (P01, P02, P03 and P07 are asked most).
2. Read two casebook incidents and write your own safeguard lists before reading ours.
3. Alternate atlas systems with W01 mock sessions, scoring each one.
4. Use W02 and W04 weekly; use W05 daily.
