# C04 — Facebook outage, 4 October 2021 (backbone, BGP and DNS)

*A real incident, told from the operator's own published account. The lessons section is our analysis and is labelled as such. Sources and what was not checked are at the end.*

## At a glance

**What happened.** A maintenance command meant to assess backbone capacity took down all backbone connections. DNS servers saw they could not reach the data centers, withdrew their BGP advertisements, and became unreachable from the internet. Internal tools broke too, so engineers had to go on site.

**Key facts** (as published)
- The trigger was a routine backbone maintenance job; an audit tool that should have stopped the command had a bug `[CONFIRMED]`.
- DNS servers withdraw BGP advertisements when they cannot reach the data centers, so the whole backbone loss made DNS unreachable `[CONFIRMED]`.
- Data centers reported power dips on the order of tens of megawatts, so services were restored carefully `[CONFIRMED]`.

**Why it matters for architects.** A health-check rule that is correct for one failure (a single facility isolated) turned a total outage into an invisible one when it applied to every facility at once, and the recovery tools depended on the thing that was down.

---

## What happened `[CONFIRMED]`

The post, by Meta's infrastructure engineering lead, says the outage was triggered by the system that manages global backbone capacity. During maintenance, "a command was issued with the intention to assess the availability of global backbone capacity, which unintentionally took down all the connections in our backbone network". Facebook's systems audit such commands, but a bug in that audit tool prevented it from properly stopping the command. Smaller facilities answer DNS queries, with authoritative name servers whose addresses are advertised through BGP. To keep unhealthy locations from attracting traffic, DNS servers disable their BGP advertisements if they cannot speak to the data centers. With the entire backbone gone, every location declared itself unhealthy and withdrew its advertisements, so the rest of the internet could not find Facebook's servers even though they were still operating. Engineers faced two obstacles: the normal access path was down, and the loss of DNS broke many internal tools. The out-of-band network was also down, so people were sent to the data centers, where physical and system security made access and changes slow. Once the backbone returned, services were brought back gradually because a sudden return of load could cause new failures; long-running storm drills, which simulate taking a service, data center or region offline, helped.

## Contributing factors `[CONFIRMED]`

- No limit or working audit stopped a command that affected the whole backbone.
- A DNS health rule withdrew BGP routes network-wide when connectivity to the data centers was lost.
- Internal tools, remote access and the out-of-band network were affected, and physical access was deliberately hard.

## What the company changed `[CONFIRMED]`

- An extensive review process was started; the post commits to strengthening testing, drills and resilience.
- It notes the team had never run a storm drill that took the global backbone offline and would look at simulating it.
- The author argues that hardening against unauthorized access is worth a slower recovery from a rare self-made outage.

---

## 🔧 Our analysis (not from the source)

**Questions a design review could have asked**
- Which health rules withdraw capacity automatically, and what happens if all instances trip at once? Is there a floor?
- Can we reach our systems if DNS, the identity provider and the primary network are all down?
- Which commands can affect every site, and what independent check blocks them?
- What is the plan for a cold start of everything at once, including power and cache load?

**Related notes:** [13 Netflix](../systems/13-netflix.md) for control plane versus data plane; [29 Live streaming](../systems/29-live-streaming-twitch.md) for backbone and PoP design.

## Practice

Redesign the DNS health rule so a total backbone loss does not make DNS disappear. What is the new failure mode?

## Sources and provenance

> **Sources read on 2026-10-27:** Santosh Janardhan, Engineering at Meta, [*More details about the October 4 outage*](https://engineering.fb.com/2021/10/05/networking-traffic/outage-details/) (5 October 2021).
> **Dated material:** 2021. The post is short and a company statement; it omits many details.
> **Not read:** Meta's other posts on the incident, and third-party network measurements of the BGP withdrawals.
> **Tags:** `[CONFIRMED]` stated by the primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Sections marked "Our analysis" are ours.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading the full text of the source. Quotations are confirmed by `npm run verify`.*
- Verified in the Meta post: the trigger, the audit-tool bug, the DNS and BGP health behaviour, the response obstacles, the gradual restart and power concern, the storm drills and the security trade-off statement.
- Our analysis section is not sourced.
