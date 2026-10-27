# 13 — Netflix (Video Delivery)

> **Kind:** real-system, for the part Netflix documents: **how video is delivered**. Netflix publishes a lot about its CDN, **Open Connect**, and the playback steering that points each client at a nearby appliance. It publishes far less on the rest (catalog, recommendations, encoding pipeline), so this note covers delivery and explicitly leaves out what we could not source.
> **Sources read on 2026-10-27:** [Open Connect Overview (PDF)](https://openconnect.netflix.com/Open-Connect-Overview.pdf) (copyright dates 2016, 2019, 2026; text extracted locally) · [Open Connect home page](https://openconnect.netflix.com/en/) · Netflix TechBlog: [*Distributing Content to Open Connect*](https://netflixtechblog.com/distributing-content-to-open-connect-3e3e391d4dc9) (2017-12-12) and [*Driving Content Delivery Efficiency Through Classifying Cache Misses*](https://netflixtechblog.com/driving-content-delivery-efficiency-through-classifying-cache-misses-ffcf08026b6c). Both blog posts blocked direct fetches, so we read the Internet Archive copies of the pages.
> **Not read:** Netflix's encoding (per-title) posts, its API/gateway and microservice posts, chaos-engineering material, and the Open Connect deployment requirements (blocked). Those topics are **not** covered here.
> **Dated material:** the Overview is a living document. The 2017 placement post and the cache-miss post describe the systems at those dates.
> **Tags:** `[CONFIRMED]` stated by a Netflix primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible.

---

## 🧒 Non-technical explanation

Imagine a video-rental chain that doesn't ship from one central warehouse. Instead it puts a **small, well-stocked shelf inside every neighbourhood's local post office**. Before a new movie is popular, the chain predicts what people nearby will want and **restocks those shelves overnight**, when the roads are empty.

When you press play, head office (which is far away and only does paperwork) checks your membership and then hands you **a list of the closest shelves, best first**. Your player grabs the film from the nearest one. Head office never touches the movie itself.

Two things matter: **the shelf stocking is planned ahead, not on demand**, and **the heavy lifting happens at the edge, not at head office**.

---

## TL;DR for engineers

- **Two planes.** A **control plane in AWS** handles playback authorisation, licensing, file selection and **steering**. A **data plane**, the **Open Connect CDN**, serves the video bytes from **Open Connect Appliances (OCAs)** `[CONFIRMED]` (Overview).
- **OCAs sit inside ISP networks** (free to qualifying ISPs) or at internet exchange points, so traffic stays local `[CONFIRMED]`.
- **Proactive, directed caching** instead of demand-driven caching: popular content is **pre-positioned during off-peak "fill" windows** `[CONFIRMED]`.
- **OCAs only do two things:** report status to the control plane and serve HTTP/HTTPS. They hold no client data (no viewing history, DRM or member data) `[CONFIRMED]`.
- **Steering = rank-ordered URLs.** The Steering Service uses what OCAs report (health, BGP routes learned, files stored) plus client info to return **ranked URLs**. The client connects to the top-ranked OCA `[CONFIRMED]`.
- **Content placement** uses **consistent hashing** with many slices per server (1000 per server in 2017), extended by **Heterogeneous Cluster Allocation** for mixed hardware `[CONFIRMED]` (2017 post).

---

## 1. Why this design (Netflix's stated reasons) `[CONFIRMED]`

From the Overview: Netflix began Open Connect in **2011**, for two reasons. (1) As Netflix became "a significant portion of overall traffic" on ISP networks, it had to work "in a direct and collaborative way" with ISPs. (2) A solution built for Netflix enabled "a proactive, directed caching solution that is much more efficient than the standard demand-driven CDN solution, reducing the overall demand on upstream network capacity by several orders of magnitude".

The mission, in Netflix's words: localise Netflix traffic "as close as possible to our members, limiting the network and geographical distances that our video bits must travel during playback".

**Why proactive caching works for Netflix** (from the Overview): "Because we can predict with high accuracy what our members will watch and what time of day they will watch it, we make use of non-peak bandwidth to download the vast majority of content updates to the OCAs ... during these configurable time windows." OCAs can also **download updates from each other**, reducing backbone use. This predictability is specific to a catalogue service. A user-generated video site (see [12 YouTube](12-youtube.md)) cannot pre-position uploads it has not seen yet `[INDUSTRY PATTERN]`.

---

## 2. Open Connect Appliances and how they are deployed `[CONFIRMED]`

- **OCAs** are purpose-built cache servers that "temporarily store encoded video/image files and make these files available via HTTP/HTTPS". They have "the sole responsibility of storing playable bits". Netflix says it is involved in all layers of the software stack and publishes the hardware design and software as open source.
- **Two deployment modes:** (1) OCAs installed **in internet exchange points** in significant markets, interconnected with ISPs through **settlement-free peering (SFI)**. (2) OCAs **provided free of charge to qualifying ISPs**, installed **inside the ISP's network**. Netflix supplies the hardware, the ISP supplies power, space and connectivity. "ISPs directly control which of their customers are routed to their embedded OCAs." Embedded sites also use peering for resiliency and for efficient nightly fill and updates.
- **Scale as stated on the Open Connect page:** partners with "over a thousand ISPs" and "60+ global data centers". Setup "typically takes 1-2 weeks" and shipping about a week.
- **Hardware types (2017 post):** **Storage** servers (mostly spinning disks, "upwards of 200 TB", about **40 Gbps**) and **Flash** servers (all SSD, up to about **100 Gbps** but only up to **18 TB**). The post says Netflix built 100 Gbps servers in 2016, and that most Flash servers in production were 40 Gbps with 12 TB disks at the time. For small to medium ISP co-locations, it ships Storage servers (the post's sentence is cut off in our copy, so we do not quote the rest).

---

## 3. Control plane and steering `[CONFIRMED]`

The playback process (Overview and cache-miss post):

1. **OCAs report** health and capacity, **BGP routes** they have learned from their configured BGP session, and **which files they hold** to the **Cache Control Service (CCS)** in AWS, periodically and independently of client requests.
2. A member presses play. The request goes to **Playback Apps** in AWS.
3. Playback Apps **check user authorisation and licensing**, then determine **which specific files** the playback needs, taking client characteristics and network conditions into account.
4. The **Steering Service** uses the data in CCS (and client information such as geolocation) to pick OCAs that can serve those files, and **generates URLs** for them.
5. The URLs return to the client as a **rank-ordered list**. The client connects to the top-ranked OCA and requests files.

**Proximity rank:** for each playback, the Steering Service computes a ranked list of local sites for the client, "ordered by network proximity alone", where proximity is derived from the **IP ranges (BGP routes) advertised by ISP partners**. The most proximal site is the one advertising "the longest, most specific matching prefix" to the client's IP.

**OCAs also interact with the control plane for fill:** the control plane services "control fill behavior (adding new files to OCAs nightly), compute optimal behavior for such things as file storage/hashing, and handle the storage and interpretation of relevant telemetry about the playback experience."

**Client side:** Open Connect partners with Netflix client teams so served content "is optimized dynamically by each client device based on its specific needs and the current network conditions", which is adaptive streaming. The documents we read do not describe the client algorithm.

---

## 4. Placing content on OCAs `[CONFIRMED]` (2017 post)

**Goals:** put the most popular content on each cluster to maximise traffic served locally, balance popular content across servers in the cluster, keep allocation stable day to day and when servers are added or removed, and keep compute reasonable.

**Uniform consistent hashing:** servers and content IDs are hashed onto the same ring, with each server hashed **1000 times** for even distribution, and for each content item the post says "we find as many owners as we need replicas". Content added or removed from the catalogue affects only the server that must download or delete it. Adding a server takes roughly equal slices from the others.

**Why it was not enough:** a heterogeneous fleet breaks uniformity.
- *Differing storage:* in a cluster of four 100 TB servers and one 50 TB server, uniform hashing "drops about 1/5th of content from the 250th to 500th TB mark", creating a **"content hole"** that can make content unavailable.
- *Differing throughput:* mixing 100 Gbps/18 TB and 40 Gbps/12 TB servers needs traffic proportions of roughly 5:2, but uniform hashing sends traffic proportional to storage, about 3:2.

**Heterogeneous Cluster Allocation (HCA):** keep consistent hashing, but use two stages, each with its own weighted ring, switching at a catalogue-depth cutoff D. Weights come from an optimisation using each server's storage and throughput and the region's popularity curve. The chosen cutoff is the feasible one with the least churn. The post reports "content holes substantially reduced and significant improvements in load balance".

---

## 5. Measuring delivery efficiency: classifying cache misses `[CONFIRMED]`

A **cache miss** in Netflix's definition is client-centric: bytes "not served from the best available OCA for a given Netflix client, independent of OCA state". It is logged when bytes do not stream from any OCA in the **first site of the proximity rank**. Two logs are joined: **steering playback manifest logs** (the ranked list the Steering Service computed, plus the filters applied) and **OCA server logs** (what each OCA actually streamed). Both go to **Kafka** clusters in each evaluated AWS region.

The post says misses fall into **three** logical categories. In the copy we read, two were named:
- **Content miss:** files not found on OCAs in the local site (prediction, pre-positioning speed, hardware and storage provisioning).
- **Health miss:** the local site's OCAs are saturated, so clients are directed to other OCAs with capacity. Each OCA has a control loop watching bottleneck metrics such as CPU and disk.

Because the steering manifest logs the logic applied to each rank, Netflix can **replay or simulate scenarios**, such as an outage across all first-rank sites overwhelming the second rank.

---

## 6. Reference sequence for an interview `[INDUSTRY PATTERN]` unless tagged

```
Client ─(1) play──► Playback Apps (AWS) ─ auth + licence ──► choose files for this device
                          │
                          ▼ (2)
                   Steering Service ◄── Cache Control Service ◄── OCAs report: health, BGP routes, files [CONFIRMED]
                          │ (3) ranked URLs [CONFIRMED]
Client ◄──────────────────┘
Client ─(4) HTTP(S) segments──► top-ranked OCA (in ISP / IXP) ─ miss → next in rank or fill source
```

Interview points: separate **control plane** (small, stateful, in a cloud region) from **data plane** (huge, stateless-ish, at the edge) · plan **fill** off-peak from predicted popularity · give clients a **ranked list** so they can fail over to the next OCA (the ranked list is confirmed. That clients switch mid-stream is not stated in what we read) · log the steering decision so you can audit efficiency.

---

## ⚠️ Reviewer notes

1. **"Netflix runs on AWS" is only half the story.** The documents we read place the **control plane** (playback apps, steering, cache control) in AWS. The **video bytes come from Open Connect appliances in ISPs and IXPs**, not from AWS. The interview-friendly split is control plane vs data plane.
2. **Third-party write-ups claim details we could not verify**: that OCAs "stop serving" if they lose connectivity to AWS, or that clients fail over at segment boundaries. A search result attributed the first to Netflix's deployment-requirements page, but we could not read that page (HTTP 403), so we do not state it.
3. **The Overview calls this kind of network a CDN ("Content Delivery Network") but stresses the differences.** Netflix emphasises the proactive, directed model. Do not describe Open Connect as a generic pull-through cache.
4. **Old numbers.** The 100 Gbps and 18 TB figures describe 2016–2017 hardware. The Open Connect home page says "60+ data centers" now. Neither tells you today's appliance specs.
5. **We did not cover encoding.** Per-title and per-shot encoding, codecs and the packaging pipeline are real Netflix topics, but we read no Netflix source on them for this note, so we make no claims.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from Netflix. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance/latency** (start time and rebuffering), **scalability** and **elasticity** (global events), **availability**, **cost efficiency** (backbone and transit), **evolvability** (new hardware coexists with old).
- **Style (Ch 9, 17):** a **distributed, two-plane** architecture: a microservices control plane and a purpose-built edge data plane. The "intelligence at the control plane, dumb fast edge" split is the key idea.
- **Quanta (Ch 7):** the OCA fleet and the AWS control plane are separate quanta. Per the Overview, OCAs hold no member data and only report status and serve content, which keeps the edge simple and keeps sensitive data out of ISP networks.
- **Trade-off (First Law, Ch 1):** **predictive pre-positioning vs generality.** It cuts upstream traffic dramatically, but it only works because the catalogue is finite and demand is predictable. Misses (content miss, health miss) are the price.
- **ADR sketch (Ch 19):** *"We will pre-position content on edge appliances in ISP networks during off-peak windows and steer clients with ranked URLs from a central control plane. We accept the cost of building and operating our own CDN and appliances."*
- Plain English: stock the neighbourhood shelves overnight, and let head office just hand out directions.

---

## Interview questions to practice

1. Where does Netflix's video actually come from, and what is the role of AWS?
2. What are the control plane and data plane in a CDN, and why separate them?
3. Design the steering: what does an edge server report, and how do you rank candidate servers for a client?
4. How would you decide which titles go on which edge servers? What goes wrong with a mix of small and large servers?
5. Why can proactive caching beat demand-driven caching for Netflix but not for YouTube?
6. How do you measure whether your CDN is serving bytes from the right place?

## 📚 Further reading

- The sources listed at the top, plus the [Open Connect briefing paper](https://openconnect.netflix.com/Open-Connect-Briefing-Paper.pdf) and Netflix's "Serving 100 Gbps from an Open Connect Appliance" post (both surfaced in search, not read here).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (CDN section, secondary).
- Related in this repo: [12 YouTube](12-youtube.md) (on-demand upload/transcode contrast), [03 Distributed KV store](03-distributed-kv-store.md) (consistent hashing).

---
## ✅ Verification log

*Fact-check, 2026-10-27.* The Overview was extracted from the PDF and read in full. The Open Connect home page was fetched. The two TechBlog posts were read from Internet Archive copies.
- Verified in the Overview: Open Connect began in 2011 and the two reasons; "proactive, directed caching" and "several orders of magnitude"; OCAs store encoded files, serve HTTP/HTTPS, store no client data; two deployment modes; ISPs control routing to embedded OCAs; OCAs report health, BGP routes and files to AWS control plane services; the five-step playback flow; control plane controls fill and telemetry; off-peak fill windows; OCAs can fetch updates from each other; hardware and software are open source.
- Verified on the Open Connect page: free embedded OCAs for qualifying ISPs, SFI at IXPs, "over a thousand ISPs", "60+ global data centers", 1–2 weeks setup.
- Verified in the 2017 post: placement goals, consistent hashing with 1000 slices per server, the storage and throughput heterogeneity examples (1/5th content hole, 5:2 vs 3:2), HCA two-stage design, Storage and Flash server figures.
- Verified in the cache-miss post: Cache Control Service, Playback Apps, Steering Service, rank-ordered URLs, proximity rank from BGP prefixes, client-centric miss definition, manifest and OCA logs to Kafka, content-miss and health-miss definitions.
- Dropped: "OCAs stop serving if AWS is unreachable" and "clients fail over at segment boundaries" (not in the pages we read), anything about encoding and the wider Netflix service architecture.
- Softened: the cache-miss post says three categories, and only two were visible in the copy we read, so we name only those two.
- Method note: the TechBlog posts were read through the Internet Archive because direct requests returned 403. We did not compare them to the live pages, and the cache-miss post is the more recent of the two.
- Quote audit (2026-10-27): the consistent-hashing quote now reads "we find as many owners as we need replicas" as in the post, and a paraphrase that had been put in quotation marks ("typically referred to as a CDN") was reworded.
