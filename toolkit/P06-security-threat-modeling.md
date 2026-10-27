# P06 — Security for architects: threat modeling and zero trust

*A primer on thinking about security at design time. The method comes from the Threat Modeling Manifesto and OWASP; the architecture principles come from NIST SP 800-207. The checklist applying them to system design is our reasoning and is labelled.*

## At a glance

Security is mostly an architecture property: where trust boundaries are, who can call what, what is stored, and what an attacker gains from each failure. Retrofitting it is expensive. The two ideas worth knowing precisely are **threat modeling** (a lightweight, repeatable way to find what can go wrong at design time) and **zero trust** (do not grant access because of network location).

**In 60 seconds:** draw the system with its data flows and trust boundaries; for each boundary ask what can go wrong; choose a response (mitigate, eliminate, transfer or accept); check whether you did a good enough job; repeat as the design changes. Design every service so being "inside the network" grants nothing.

---

## 1. Threat modeling `[CONFIRMED]` (Threat Modeling Manifesto; OWASP)

The Manifesto defines threat modeling as "analyzing representations of a system to highlight concerns about security and privacy characteristics", organised around four questions: **What are we working on? What can go wrong? What are we going to do about it? Did we do a good enough job?** It lists values, for example "a culture of finding and fixing design issues over checkbox compliance", "people and collaboration over processes, methodologies, and tools", and "continuous refinement over a single delivery". It is methodology-agnostic and says the best use of threat modeling is to improve security and privacy "through early and frequent analysis".

OWASP's Threat Modeling Cheat Sheet adds practical points. Proper threat modeling needs an understanding of "data flows, trust boundaries, and other characteristics of the system"; there is "no universally accepted industry standard", but most approaches include system modeling, threat identification and risk response. It lists Adam Shostack's four **responses to a threat**: **mitigate** (reduce the likelihood), **eliminate** (remove the feature or component causing it), **transfer** (assign contractual or financial responsibility, noting this does not itself reduce likelihood or impact, so document who owns residual risk) and **accept**. For cloud-native systems it says traditional techniques such as STRIDE or data-flow diagrams often need adaptation, because of shared responsibility models, managed services and APIs, multi-tenancy and identity federation, and dynamic infrastructure.

## 2. Zero trust `[CONFIRMED]` (NIST SP 800-207)

NIST describes zero trust (ZT) as "an evolving set of cybersecurity paradigms that move defenses from static, network-based perimeters to focus on users, assets, and resources", where trust is not granted "based solely on their physical or network location". Its tenets, in its own words, include:
1. All data sources and computing services are considered resources.
2. All communication is secured regardless of network location; "network location alone does not imply trust".
3. Access to individual resources is granted on a per-session basis, with the least privileges needed, and access to one resource does not automatically grant access to another.
4. Access is determined by dynamic policy, including the observable state of client identity, application or service and the requesting asset, and possibly behavioural and environmental attributes.

The document also lists threats to a zero trust architecture itself, among them subversion of the decision process, denial of service, stolen credentials or insider threat, and reliance on proprietary data formats.

## 3. A design-time checklist `[INDUSTRY PATTERN]`

Use it as questions to ask of any atlas design:

| Area | Questions |
|---|---|
| Trust boundaries | Where does data cross from a less trusted to a more trusted zone (internet to edge, tenant to tenant, model output to tools)? What validates it there? |
| Identity | How is every caller (user, service, job) authenticated? Are service credentials short-lived and narrowly scoped? |
| Authorization | Is it enforced at the data layer or only in the UI? Can one tenant ever see another's data (see [23 RAG assistant](../systems/23-rag-knowledge-assistant.md) for permission filtering)? |
| Data | What is stored, for how long, encrypted how, with whose keys? What is the blast radius of a database leak (see [08 Chat](../systems/08-chat-whatsapp.md) on end-to-end encryption)? |
| Untrusted execution | Does the system run code or content from users or models? Isolate it (see [25 AI agent platform](../systems/25-ai-agent-platform.md): sandboxes and prompt injection). |
| Abuse | Rate limits, quotas, bot defence (see [02 Rate limiter](../systems/02-rate-limiter.md)). |
| Operations | Who can change production, and how is that audited? Can responders still get in when something breaks (see [C02 Cloudflare 2019](C02-cloudflare-2019.md), where credentials had timed out)? |
| Failure of controls | What happens when the auth service or key store is down: fail open or closed, and who decided? |
| STRIDE prompts | A common mnemonic for threat categories: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege. Walk each boundary with it. |

**Tension to state in interviews:** security controls trade against availability and recovery speed. Meta's 2021 outage write-up says its hardening slowed recovery and that the author considers the trade worth it ([C04 Facebook 2021](C04-facebook-2021.md)). Say which side you chose and why.

---

## Questions to practise

1. Walk through a threat model for a file-sharing service using the four questions.
2. What does 'zero trust' change about how services inside a datacenter call each other?
3. Name the four ways to respond to a threat. When is accepting a risk legitimate?
4. Where would you place trust boundaries in the AI agent platform from note 25?
5. Your auth service is down. Should the API fail open or closed? Why?

## Practice

Pick one atlas design, draw its data-flow diagram with trust boundaries, list five threats, and for each choose mitigate, eliminate, transfer or accept with a one-line reason.

**Related:** [02 Rate limiter](../systems/02-rate-limiter.md), [08 Chat](../systems/08-chat-whatsapp.md), [23 RAG knowledge assistant](../systems/23-rag-knowledge-assistant.md), [25 AI agent platform](../systems/25-ai-agent-platform.md), [C02 Cloudflare 2019](C02-cloudflare-2019.md), [C04 Facebook 2021](C04-facebook-2021.md).

## Sources and provenance

> **Sources read on 2026-10-27:** Threat Modeling Manifesto, [threatmodelingmanifesto.org](https://www.threatmodelingmanifesto.org/) · OWASP, [Threat Modeling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html) · Rose et al., NIST, [*SP 800-207: Zero Trust Architecture*](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf) (2020; PDF text extracted locally).
> **Dated material:** NIST SP 800-207 is from 2020; OWASP and the Manifesto are living documents read on 2026-10-27.
> **Not read:** The OWASP Top 10 and ASVS, Microsoft's STRIDE documentation, Shostack's book, supply-chain security frameworks, cloud provider security whitepapers, and privacy regulation.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Manifesto: the four questions, the definition, and the quoted values.
- Verified in the OWASP cheat sheet: the data-flow and trust-boundary statement, no universal standard, the four responses and the cloud-native adaptation note.
- Verified in NIST SP 800-207: the definition of zero trust and tenets 1 to 4 as summarised, and the existence of the threats section.
- Not sourced (our reasoning): the checklist table, the STRIDE expansion (a widely used mnemonic, not read here) and the interview prompts.
