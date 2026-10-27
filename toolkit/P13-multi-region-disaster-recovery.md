# P13 — Disaster recovery and multi-region design: RTO, RPO and the four strategies

*A primer on planning for the loss of a data center or a whole region. The terms and the four strategies come from the AWS whitepaper "Disaster Recovery of Workloads on AWS", with Google Cloud's DR planning guide and the Azure Well-Architected reliability guidance as second and third opinions; the decision method and the failure commentary are our reasoning and are labelled. It describes cloud-region disasters; it does not cover business continuity beyond the workload.*

## At a glance

**Disaster recovery (DR)** is how a workload comes back after an event that takes out its primary site: a data center or region lost, data corrupted or deleted, an account compromised. Two numbers drive every choice. The **recovery time objective (RTO)** is how long the service may be down. The **recovery point objective (RPO)** is how much recent data you may lose. Smaller numbers cost more and make the system more complex. AWS names four strategies from cheap to costly: **backup and restore**, **pilot light**, **warm standby** and **multi-site active/active**. On the hard parts: AWS warns that replication copies mistakes as well as data; AWS and Azure both say the recovery path must not depend on the thing that failed; and all three say a recovery plan you do not test regularly cannot be trusted.

**In 60 seconds:** derive RTO and RPO from the business impact and the cost of recovery, not from what sounds safe; choose the cheapest strategy that meets them (often multi-AZ plus backups is enough, and for some workloads no DR at all is valid); keep backups and the means to restore them outside the failure domain; rehearse failover regularly, including the "boring" steps such as quotas, configuration drift and access to the runbook; and distrust a design whose failover path is exercised only in a real disaster.

---

## 1. RTO and RPO as design inputs `[CONFIRMED]` (AWS; Google Cloud)

AWS defines them like this: "Recovery Time Objective (RTO) is the maximum acceptable delay between the interruption of service and restoration of service." and "Recovery Point Objective (RPO) is the maximum acceptable amount of time since the last data recovery point." Google's guide gives the same pair from the other side: the RTO is "the maximum acceptable length of time that your application can be offline", the RPO is "the maximum acceptable length of time during which data might be lost from your application due to a major incident", and an RPO can differ per kind of data (frequently modified user data may need minutes, rarely changed data hours). Both say DR planning starts with a business impact analysis.

Both also tie the numbers to cost. Google: "Typically, the smaller your RTO and RPO values are (that is, the faster your application must recover from an interruption), the more your application will cost to run." AWS warns that "recovery objectives should not be made in isolation": the probability of disruption and the cost of recovery matter too, and "If the cost of the recovery strategy is higher than the cost of the failure or loss, the recovery option should not be put in place unless there is a secondary driver such as regulatory requirements." It even says that "For less critical workloads, a valid strategy may be not to have any disaster recovery in place at all", and that "a multi-AZ architecture within an AWS Region may already meet much of your risk mitigation needs", because availability zones are placed far enough apart that most common disasters hit one. Targets also depend on time: a payroll system's downtime costs far more just before payday than just after.

## 2. The four strategies `[CONFIRMED]` (AWS)

AWS: "Disaster recovery strategies available to you within AWS can be broadly categorized into four approaches, ranging from the low cost and low complexity of making backups to more complex strategies using multiple active Regions."

| Strategy | What exists in the recovery region before a disaster | What AWS says |
|---|---|---|
| **Backup and restore** | Backups (and copies of code, configuration and images) only | "a suitable approach for mitigating against data loss or corruption"; you must redeploy infrastructure, so "you should always deploy using infrastructure as code (IaC)" |
| **Pilot light** | Data replication and the core infrastructure; "Resources required to support data replication and backup, such as databases and object storage, are always on", the application servers are switched off | Cannot serve requests until you turn things on and scale up |
| **Warm standby** | "a scaled down, but fully functional, copy of your production environment in another Region" | Handles traffic "(at reduced capacity levels) immediately"; you only scale up |
| **Multi-site active/active** | A full workload serving traffic in several regions | "the most complex and costly approach", and it "can reduce your recovery time to near zero for most disasters"; corruption may still need backups, so the recovery point is usually not zero |

The same page notes that for the loss of one data center, a well-architected, highly available workload may need only backup and restore; for the loss of a whole region, or a regulatory requirement, consider the other three. Pilot light and warm standby both keep a copy running; the difference AWS draws is that pilot light "cannot process requests without additional action taken first". Use RTO and RPO to choose between them. (The qualitative ordering of cost and recovery time follows AWS's own ranking; the sources here give no figures.)

## 3. Why recovery fails `[CONFIRMED]` (AWS; Azure; Google Cloud), with our commentary

- **Replication is not a backup.** AWS: continuous replication gives the shortest time to a copy, "but may not protect against disaster events such as data corruption or malicious attack" as well as point-in-time backups do. It suggests object versioning for human-error disasters, and cross-account backup copies against insider threats or account compromise (and, for the pilot light strategy, a different account per region). Our reading: a bad deploy or a mass delete replicates to the standby within seconds; keep a path back to a point in time.
- **Do not fail over through the broken thing.** AWS distinguishes the data plane (serves traffic) from the control plane (configures the environment): "For maximum resiliency, you should use only data plane operations as part of your failover operation", because data planes typically have higher availability goals. It also points out that restoring from backup is itself a control plane operation, so a periodic scheduled restore leaves you operable data stores if the control plane is unavailable. Azure makes a related point about tooling: "Store disaster recovery documentation, scripts, and recovery components in highly available, secure locations so they remain accessible even during regional outages", and "Predeploy CI/CD pipelines in every region so they're ready to run immediately when needed." Our reading: it is the same lesson as the access-path failures in [C04 Facebook](C04-facebook-2021.md) and the status page that depended on the failing service in [C01 S3](C01-aws-s3-2017.md).
- **Untested paths rot.** AWS: "A pattern to avoid is developing recovery paths that are rarely executed", with the example of a secondary data store whose capacity or regional service quotas turn out to be too small on the day. "Our experience has shown that the only error recovery that works is the path you test frequently." It adds "Manage configuration drift at the DR Region" (stale images, quotas). Google: "After you create a DR plan, test it regularly", and it asks that each task in the plan be a concrete, unambiguous action, so no one is guessing during an incident.
- **Automation needs people.** Azure: "Even with automation, trained operators must oversee recovery processes and intervene if issues arise", and drills should "adjust failover thresholds to reduce the risk of false positives". Our reading: a failover that triggers on a transient blip, or that splits the brain between two regions, is itself an outage; see the failover reasoning in [33 Coordination and locks](../systems/33-distributed-coordination-locks.md) and the region-loss flow in [30 Metrics monitoring](../systems/30-metrics-monitoring-alerting.md).

## 4. A way to choose `[INDUSTRY PATTERN]`

This is our reasoning, a checklist and not a rule from any source.

1. **Name the disasters** you plan for (host, zone, region, data corruption, account compromise) and how likely each is. Each may need a different mechanism: replication does not help with corruption; backups do not help with a 10-minute RTO.
2. **Set RTO and RPO per workload**, from the cost of downtime and data loss, and write down the cost of the strategy that meets them. If the strategy costs more than the loss, argue for a cheaper target.
3. **Pick the cheapest strategy that meets both numbers**, and say what you give up (see the table in section 2). Treat multi-site active/active as a business decision about cost and complexity, as much as a technical one.
4. **Separate the data story from the compute story.** State the recovery point for each data store and what protects it from corruption.
5. **Make the recovery path small and independent**: few steps, scripted, no dependency on the failing region's control plane, runbooks and credentials reachable from outside it.
6. **Rehearse on a schedule**, measure the real RTO and RPO, and check drift (quotas, images, configuration) each time. Connect the numbers to your SLOs in [P07](P07-slos-and-incidents.md) and the spend to [P08](P08-cost-as-a-design-input.md).

---

## Questions to practise

1. Define RTO and RPO, and say which strategy you would choose for a 4-hour RTO with a 15-minute RPO on a mid-sized service, and why.
2. Why is continuous replication not a backup? Give two disasters it does not protect against.
3. What is the difference between pilot light and warm standby?
4. What is the control plane/data plane distinction, and how should it shape a failover runbook?
5. Why might a multi-AZ design already be enough, according to AWS?
6. A team has a documented multi-region plan that has never been run. What are the three most likely reasons it fails?
7. When is having no disaster recovery at all a defensible decision?

## Practice

Pick an atlas system with a data store, such as [05 Object storage](../systems/05-object-storage-s3.md) or [17 Payments](../systems/17-payment-system.md). Write a one-page DR plan: the disasters you plan for, RTO and RPO per data store, the strategy for each, what protects against corruption and mass deletion, how failover is triggered and by whom, what it depends on, and a drill schedule. Then play the drill: say what you would find wrong on day one.

---

## Sources and provenance

> **Sources read on 2026-10-27:** AWS, [*Disaster Recovery of Workloads on AWS: Recovery in the Cloud*](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html), the pages [Business Continuity Plan](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/business-continuity-plan-bcp.html), [Disaster recovery options in the cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html) and [Testing disaster recovery](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/testing-disaster-recovery.html) (undated pages, read as served) · Google Cloud, [*Disaster recovery planning guide*](https://cloud.google.com/architecture/dr-scenarios-planning-guide) (last reviewed 2024-07-05) · Microsoft, [*Architecture strategies for disaster recovery*](https://learn.microsoft.com/en-us/azure/well-architected/reliability/disaster-recovery) (Azure Well-Architected Framework, updated 2025-11-19).
> **Dated material:** the vendor pages are revised without notice and describe their own platforms; the concepts (RTO, RPO, the four strategies, testing) are stable, the product names are not.
> **Not read:** the rest of the AWS whitepaper (the sections on high availability versus disaster recovery, detection, and the service-by-service details), the other parts of Google's DR series (data and applications), Azure's multi-region plan article, any measurement of how often DR plans succeed, and the SRE-style treatments of regional evacuation.
> **Tags:** `[CONFIRMED]` stated by a primary source we read · `[INDUSTRY PATTERN]` standard practice or our reading of the sources · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the AWS pages: the RTO and RPO definitions, the business-impact and cost reasoning (including the no-DR and multi-AZ remarks and the cost caveat), the four strategies and their descriptions, the pilot-light versus warm-standby distinction, the data plane and control plane advice, the replication-versus-corruption warning, versioning and cross-account backup advice, and the testing guidance.
- Verified in Google's guide: the RTO and RPO definitions, the cost-versus-objective relationship, the cold, warm and hot patterns, and the advice to test the plan regularly and make tasks concrete.
- Verified in the Azure page: the advice to keep DR documentation and pipelines available in every region, and the warnings about automation and false-positive failovers.
- Not claimed: any cost or recovery-time figure for a strategy; that one cloud's approach is better; how any named company does DR.
- Our reasoning, not from the sources: the table's ordering note, every "our reading" sentence, and the checklist in section 4.
