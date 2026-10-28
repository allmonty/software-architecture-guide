# 13 — Netflix (Video Delivery)

*Um sistema real documentado. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** A Netflix separa o controle dos dados. Um control plane na AWS autentica, escolhe os arquivos para um dispositivo e o direciona para um appliance Open Connect próximo, enquanto os appliances dentro dos ISPs e dos pontos de troca de tráfego servem o vídeo. O conteúdo é pré-posicionado durante a madrugada a partir da popularidade prevista, então a rede carrega bem menos tráfego do que carregaria um cache guiado pela demanda.

**Números principais**
- Mais de mil parceiros ISP e mais de 60 data centers `[CONFIRMED]`.
- Cada servidor recebe o hash 1000 vezes no anel para o placement `[CONFIRMED]` (2017).
- Servidores de storage com ~40 Gbps e 200 TB+, flash com até ~100 Gbps e 18 TB `[CONFIRMED]` (2017).

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Pré-posicionamento proativo | A demanda previsível reduz o tráfego upstream | Erros quando as previsões estão erradas (content miss) |
| Appliances embutidos nos ISPs | O tráfego fica local | Hardware para enviar e operar |
| URLs ranqueadas por um serviço central de steering | O cliente pode escolher o melhor site | O control plane precisa continuar disponível |

**Erros comuns**
- Dizer que o vídeo vem da AWS: o control plane está na AWS, os bytes vêm do Open Connect.
- Afirmar que os OCAs param de servir sem a AWS: não conseguimos verificar.
- Tratar os números de hardware de 2017 como atuais.


---

## 🧒 Non-technical explanation

Imagine uma rede de locação de vídeo que não despacha de um depósito central. Em vez disso, ela põe uma **prateleira pequena e bem abastecida dentro da agência de correio local de cada bairro**. Antes de um filme novo ficar popular, a rede prevê o que as pessoas por perto vão querer e **reabastece essas prateleiras durante a madrugada**, quando as ruas estão vazias.

Quando você aperta play, a matriz (que fica longe e só cuida da papelada) confere a sua assinatura e depois te entrega **uma lista das prateleiras mais próximas, a melhor primeiro**. Seu player pega o filme na mais próxima. A matriz nunca toca no filme em si.

Duas coisas importam: **o abastecimento das prateleiras é planejado com antecedência, não sob demanda**, e **o trabalho pesado acontece na borda, não na matriz**.

---

## TL;DR for engineers

- **Dois planos.** Um **control plane na AWS** cuida da autorização de reprodução, do licenciamento, da seleção de arquivos e do **steering**. Um **data plane**, a **CDN Open Connect**, serve os bytes do vídeo a partir de **Open Connect Appliances (OCAs)** `[CONFIRMED]` (Overview).
- **Os OCAs ficam dentro das redes dos ISPs** (de graça para ISPs qualificados) ou em pontos de troca de tráfego, de modo que o tráfego fica local `[CONFIRMED]`.
- **Caching proativo e dirigido** em vez de caching guiado pela demanda: o conteúdo popular é **pré-posicionado em janelas de "fill" fora do pico** `[CONFIRMED]`.
- **Os OCAs só fazem duas coisas:** reportar o status ao control plane e servir HTTP/HTTPS. Eles não guardam dados de clientes (nem histórico de visualização, DRM ou dados de membros) `[CONFIRMED]`.
- **Steering = URLs em ordem de rank.** O Steering Service usa o que os OCAs reportam (saúde, rotas BGP aprendidas, arquivos armazenados) mais informações do cliente para devolver **URLs ranqueadas**. O cliente se conecta ao OCA de maior rank `[CONFIRMED]`.
- O **placement de conteúdo** usa **consistent hashing** com muitas fatias por servidor (1000 por servidor em 2017), estendido pela **Heterogeneous Cluster Allocation** para hardware misto `[CONFIRMED]` (post de 2017).

---

## 1. Why this design (Netflix's stated reasons) `[CONFIRMED]`

Do Overview: a Netflix iniciou o Open Connect em **2011**, por dois motivos. (1) À medida que a Netflix virou "a significant portion of overall traffic" nas redes dos ISPs, precisou trabalhar "in a direct and collaborative way" com eles. (2) Uma solução construída para a Netflix permitiu "a proactive, directed caching solution that is much more efficient than the standard demand-driven CDN solution, reducing the overall demand on upstream network capacity by several orders of magnitude".

A missão, nas palavras da Netflix: localizar o tráfego da Netflix "as close as possible to our members, limiting the network and geographical distances that our video bits must travel during playback".

**Por que o caching proativo funciona para a Netflix** (do Overview): "Because we can predict with high accuracy what our members will watch and what time of day they will watch it, we make use of non-peak bandwidth to download the vast majority of content updates to the OCAs ... during these configurable time windows." Os OCAs também podem **baixar atualizações uns dos outros**, reduzindo o uso do backbone. Essa previsibilidade é específica de um serviço de catálogo. Um site de vídeo gerado por usuários (veja [12 YouTube](12-youtube.md)) não consegue pré-posicionar uploads que ainda não viu `[INDUSTRY PATTERN]`.

---

## 2. Open Connect Appliances and how they are deployed `[CONFIRMED]`

- Os **OCAs** são servidores de cache feitos sob medida que "temporarily store encoded video/image files and make these files available via HTTP/HTTPS". Eles têm "the sole responsibility of storing playable bits". A Netflix diz que participa de todas as camadas da pilha de software e publica o design de hardware e o software como código aberto.
- **Dois modos de implantação:** (1) OCAs instalados **em pontos de troca de tráfego** em mercados importantes, interconectados com os ISPs por **settlement-free peering (SFI)**. (2) OCAs **fornecidos gratuitamente a ISPs qualificados**, instalados **dentro da rede do ISP**. A Netflix fornece o hardware, o ISP fornece energia, espaço e conectividade. "ISPs directly control which of their customers are routed to their embedded OCAs." Os sites embutidos também usam peering para resiliência e para fill e atualizações noturnas eficientes.
- **Escala conforme declarada na página do Open Connect:** parceria com "over a thousand ISPs" e "60+ global data centers". A configuração e o pré-fill de um OCA embutido "typically takes 1-2 weeks, depending on catalog size", e o envio é uma etapa separada de cerca de uma semana (as 1–2 semanas cobrem configuração e pré-fill, não o envio).
- **Tipos de hardware (post de 2017):** servidores de **Storage** (principalmente discos giratórios, "upwards of 200 TB", cerca de **40 Gbps**) e servidores **Flash** (todos SSD, até cerca de **100 Gbps** mas só até **18 TB**). O post diz que a Netflix construiu servidores de 100 Gbps em 2016, e que a maioria dos servidores Flash em produção eram de 40 Gbps com discos de 12 TB na época. Para colocations de ISPs pequenos e médios, ela envia servidores de Storage (a frase do post está cortada na nossa cópia, então não citamos o resto).

---

## 3. Control plane and steering `[CONFIRMED]`

O processo de reprodução (Overview e post sobre cache miss):

1. Os **OCAs reportam** saúde e capacidade, as **rotas BGP** que aprenderam em sua sessão BGP configurada e **quais arquivos guardam** ao **Cache Control Service (CCS)** na AWS, periodicamente e de forma independente das requisições dos clientes.
2. Um membro aperta play. A requisição vai para os **Playback Apps** na AWS.
3. Os Playback Apps **verificam a autorização do usuário e o licenciamento** e depois determinam **quais arquivos específicos** a reprodução precisa, levando em conta as características do cliente e as condições da rede.
4. O **Steering Service** usa os dados do CCS (e informações do cliente, como geolocalização) para escolher OCAs que consigam servir esses arquivos e **gera as URLs** para eles.
5. As URLs voltam ao cliente como uma **lista em ordem de rank**. O cliente se conecta ao OCA de maior rank e pede os arquivos.

**Proximity rank:** para cada reprodução, o Steering Service calcula uma lista ranqueada de sites locais para o cliente, "ordered by network proximity alone", em que a proximidade é derivada dos **intervalos de IP (rotas BGP) anunciados pelos ISPs parceiros**. O site mais próximo é aquele que anuncia "the longest, most specific matching prefix" para o IP do cliente.

**Os OCAs também interagem com o control plane para o fill:** os serviços do control plane "control fill behavior (adding new files to OCAs nightly), compute optimal behavior for such things as file storage/hashing, and handle the storage and interpretation of relevant telemetry about the playback experience."

**Lado do cliente:** o Open Connect trabalha com as equipes de cliente da Netflix para que o conteúdo servido seja "optimized dynamically by each client device based on its specific needs and the current network conditions", que é adaptive streaming. Os documentos que lemos não descrevem o algoritmo do cliente.

---

## 4. Placing content on OCAs `[CONFIRMED]` (2017 post)

**Objetivos:** pôr o conteúdo mais popular em cada cluster para maximizar o tráfego servido localmente, equilibrar o conteúdo popular entre os servidores do cluster, manter a alocação estável de um dia para o outro e quando servidores são adicionados ou removidos, e manter a computação razoável.

**Consistent hashing uniforme:** servidores e IDs de conteúdo recebem hash no mesmo anel, com cada servidor recebendo hash **1000 vezes** para uma distribuição uniforme, e para cada item de conteúdo o post diz "we find as many owners as we need replicas". Conteúdo adicionado ou removido do catálogo afeta apenas o servidor que precisa baixá-lo ou apagá-lo. Adicionar um servidor pega fatias aproximadamente iguais dos outros.

**Por que não bastou:** uma frota heterogênea quebra a uniformidade.
- *Storage diferente:* num cluster com quatro servidores de 100 TB e um de 50 TB, o hashing uniforme "drops about 1/5th of content from the 250th to 500th TB mark", criando um **"content hole"** que pode tornar conteúdo indisponível.
- *Throughput diferente:* misturar servidores de 100 Gbps/18 TB e de 40 Gbps/12 TB exige proporções de tráfego de cerca de 5:2, mas o hashing uniforme envia tráfego proporcional ao storage, cerca de 3:2.

**Heterogeneous Cluster Allocation (HCA):** manter o consistent hashing, mas usar dois estágios, cada um com seu próprio anel ponderado, alternando num corte de profundidade do catálogo D. Os pesos vêm de uma otimização que usa o storage e o throughput de cada servidor e a curva de popularidade da região. O corte escolhido é o viável com menor churn. O post relata "content holes substantially reduced and significant improvements in load balance".

---

## 5. Measuring delivery efficiency: classifying cache misses `[CONFIRMED]`

Um **cache miss** na definição da Netflix é centrado no cliente: bytes "not served from the best available OCA for a given Netflix client, independent of OCA state". Ele é registrado quando os bytes não vêm de nenhum OCA no **primeiro site do proximity rank**. Dois logs são cruzados: os **logs do manifest de steering de reprodução** (a lista ranqueada que o Steering Service calculou, mais os filtros aplicados) e os **logs de servidor dos OCAs** (o que cada OCA de fato transmitiu). Ambos vão para clusters **Kafka** em cada região da AWS avaliada.

O post diz que os misses se dividem em **três** categorias lógicas. Na cópia que lemos, duas foram nomeadas:
- **Content miss:** arquivos não encontrados nos OCAs do site local (previsão, velocidade do pré-posicionamento, provisionamento de hardware e storage).
- **Health miss:** os OCAs do site local estão saturados, então os clientes são direcionados a outros OCAs com capacidade. Cada OCA tem um loop de controle que observa métricas de gargalo como CPU e disco.

Como o manifest de steering registra a lógica aplicada a cada rank, a Netflix pode **reproduzir ou simular cenários**, como uma queda em todos os sites de primeiro rank sobrecarregando o segundo rank.

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

Pontos de entrevista: separe o **control plane** (pequeno, stateful, numa região de nuvem) do **data plane** (enorme, quase stateless, na borda) · planeje o **fill** fora do pico a partir da popularidade prevista · dê aos clientes uma **lista ranqueada** para que possam migrar para o próximo OCA (a lista ranqueada é confirmada. Que os clientes troquem no meio do stream não é declarado no que lemos) · registre a decisão de steering para poder auditar a eficiência.

---

## ⚠️ Reviewer notes

1. **"A Netflix roda na AWS" é só metade da história.** Os documentos que lemos colocam o **control plane** (playback apps, steering, cache control) na AWS. Os **bytes de vídeo vêm dos appliances Open Connect nos ISPs e IXPs**, não da AWS. A divisão boa para entrevista é control plane vs data plane.
2. **Textos de terceiros afirmam detalhes que não conseguimos verificar**: que os OCAs "stop serving" se perdem a conectividade com a AWS, ou que os clientes trocam de OCA nas fronteiras de segmento. Um resultado de busca atribuiu o primeiro à página de requisitos de implantação da Netflix, mas não conseguimos ler essa página (HTTP 403), então não o declaramos.
3. **O Overview chama esse tipo de rede de CDN ("Content Delivery Network"), mas ressalta as diferenças.** A Netflix enfatiza o modelo proativo e dirigido. Não descreva o Open Connect como um cache pull-through genérico.
4. **Números antigos.** Os números de 100 Gbps e 18 TB descrevem hardware de 2016–2017. A página inicial do Open Connect diz "60+ data centers" agora. Nenhum dos dois informa as especificações atuais dos appliances.
5. **Não cobrimos o encoding.** O encoding por título e por plano, os codecs e o pipeline de empacotamento são temas reais da Netflix, mas não lemos nenhuma fonte da Netflix sobre eles para esta nota, então não fazemos nenhuma afirmação.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não da Netflix. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance/latência** (tempo de início e rebuffering), **escalabilidade** e **elasticidade** (eventos globais), **disponibilidade**, **eficiência de custo** (backbone e trânsito), **evolutividade** (hardware novo convive com o antigo).
- **Estilo (Ch 9, 17):** uma arquitetura **distribuída de dois planos**: um control plane de microsserviços e um data plane de borda feito sob medida. A divisão "inteligência no control plane, borda simples e rápida" é a ideia-chave.
- **Quanta (Ch 7):** a frota de OCAs e o control plane na AWS são quanta separados. Segundo o Overview, os OCAs não guardam dados de membros e só reportam status e servem conteúdo, o que mantém a borda simples e mantém dados sensíveis fora das redes dos ISPs.
- **Trade-off (First Law, Ch 1):** **pré-posicionamento preditivo vs generalidade.** Reduz muito o tráfego upstream, mas só funciona porque o catálogo é finito e a demanda é previsível. Os misses (content miss, health miss) são o preço.
- **Esboço de ADR (Ch 19):** *"Vamos pré-posicionar conteúdo em appliances de borda nas redes dos ISPs durante janelas fora do pico e direcionar os clientes com URLs ranqueadas a partir de um control plane central. Aceitamos o custo de construir e operar nossa própria CDN e nossos appliances."*
- Em linguagem simples: abasteça as prateleiras do bairro de madrugada e deixe a matriz só distribuir as indicações.

---

## Interview questions to practice

1. De onde vem de fato o vídeo da Netflix, e qual é o papel da AWS?
2. O que são o control plane e o data plane numa CDN, e por que separá-los?
3. Projete o steering: o que um servidor de borda reporta, e como você ranqueia servidores candidatos para um cliente?
4. Como você decidiria quais títulos vão em quais servidores de borda? O que dá errado com uma mistura de servidores pequenos e grandes?
5. Por que o caching proativo pode vencer o guiado pela demanda para a Netflix mas não para o YouTube?
6. Como você mede se a sua CDN está servindo bytes do lugar certo?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: tamanho do catálogo, regiões, dispositivos, relação com os ISPs.
2. Estimar: egress de pico e storage por site.
3. API: a requisição de play devolve URLs ranqueadas.
4. Design: control plane, steering, appliances, fill.
5. Deep dive: placement com consistent hashing e hardware heterogêneo.
6. Falhas e escala: site saturado (health miss), conteúdo ausente, medir a eficiência.

**Se crescer 10×**
- Egress de pico: mais appliances embutidos e peering.
- Frotas heterogêneas: pondere o placement por storage e throughput.
- Medição: registre as decisões de steering para achar os misses.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>De onde vem o vídeo da Netflix, e o que a AWS faz?</summary>

O vídeo vem de appliances Open Connect em ISPs e IXPs. A AWS roda o control plane: autorização de reprodução, seleção de arquivos, steering e cache control.

</details>

<details><summary>Como você decidiria quais títulos vão em quais servidores?</summary>

Ranqueie pela popularidade prevista por região, faça o placement com consistent hashing e pondere os servidores por storage e throughput para que não apareçam content holes.

</details>

<details><summary>Por que o caching proativo pode funcionar para a Netflix mas não para o YouTube?</summary>

Um catálogo finito com demanda previsível pode ser pré-posicionado. Vídeos de usuários recém-enviados não podem ser previstos com antecedência.

</details>

## 📚 Further reading

- As fontes listadas no topo, mais o [Open Connect briefing paper](https://openconnect.netflix.com/Open-Connect-Briefing-Paper.pdf) e o post "Serving 100 Gbps from an Open Connect Appliance" da Netflix (ambos apareceram em buscas, não foram lidos aqui).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (seção de CDN, secundária).
- Relacionado neste repositório: [12 YouTube](12-youtube.md) (contraste com upload/transcode sob demanda), [03 Distributed KV store](03-distributed-kv-store.md) (consistent hashing).

## Sources and provenance

> **Kind:** real-system, para a parte que a Netflix documenta: **como o vídeo é entregue**. A Netflix publica bastante sobre a sua CDN, o **Open Connect**, e sobre o steering de reprodução que aponta cada cliente para um appliance próximo. Publica muito menos sobre o resto (catálogo, recomendações, pipeline de encoding), então esta nota cobre a entrega e deixa explicitamente de fora o que não conseguimos fundamentar em fontes.
> **Sources read on 2026-10-27:** [Open Connect Overview (PDF)](https://openconnect.netflix.com/Open-Connect-Overview.pdf) (datas de copyright 2016, 2019, 2026; texto extraído localmente) · [página inicial do Open Connect](https://openconnect.netflix.com/en/) · Netflix TechBlog: [*Distributing Content to Open Connect*](https://netflixtechblog.com/distributing-content-to-open-connect-3e3e391d4dc9) (2017-12-12) e [*Driving Content Delivery Efficiency Through Classifying Cache Misses*](https://netflixtechblog.com/driving-content-delivery-efficiency-through-classifying-cache-misses-ffcf08026b6c). Os dois posts do blog bloquearam fetches diretos, então lemos as cópias das páginas no Internet Archive.
> **Not read:** os posts de encoding (por título) da Netflix, seus posts sobre API/gateway e microsserviços, o material de chaos engineering e os requisitos de implantação do Open Connect (bloqueados). Esses temas **não** são cobertos aqui.
> **Dated material:** o Overview é um documento vivo. O post de placement de 2017 e o post sobre cache miss descrevem os sistemas nessas datas.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária da Netflix · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível.

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
