# Architect's toolkit

Material around the 31 system-design notes, for senior engineers preparing for interviews or for an architect role. Same rules as the atlas: primary sources only, claims tagged `[CONFIRMED]` / `[INDUSTRY PATTERN]` / `[SPECULATIVE]`, our own analysis labelled, and a verification log in every page. `npm run validate`, `verify`, `links` and `freshness` cover this folder too.

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

Planned: primers (`P`) on estimation, database choice, distributed transactions, load balancing, API design, security, SLOs and cost; and a workbook (`W`) of exercises with rubrics.
