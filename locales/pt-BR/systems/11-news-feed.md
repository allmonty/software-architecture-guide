# 11 — News Feed (Twitter / Instagram)

*Um reference design construído sobre building blocks verificados. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um news feed tem dois trabalhos: encontrar posts candidatos e ranqueá-los. A geração de candidatos é um problema de fan-out: empurrar cada post para os caches de timeline dos seguidores (fan-out on write) deixa as leituras rápidas mas amplifica as escritas para contas grandes, então os sistemas reais misturam isso com pull-on-read. O pipeline publicado do Twitter então hidrata features, pontua, filtra e mistura. Os IDs precisam ordenar por tempo e codificar o shard.

**Números principais**
- Cache de timeline do Twitter (Haplo) em Redis: 40M–100M de comandos/s agregados (2017) `[CONFIRMED]`.
- Cerca de 50% dos posts do For You vêm da fonte in-network do search index; ~6.000 features são hidratadas `[CONFIRMED]` (código de 2023).
- IDs do Instagram: 41 bits de tempo + 13 bits de shard + 10 bits de sequência `[CONFIRMED]` (2012).

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Fan-out on write | Leituras muito rápidas | Amplificação de escrita para contas grandes |
| Híbrido para contas muito grandes | Limita os dois custos | Dois caminhos de código e um limiar ajustado |
| Guardar IDs de posts nas timelines | Edições e deletes não exigem fan-out | Hidratação a cada leitura |

**Erros comuns**
- Declarar um limiar de seguidores para o híbrido do Twitter: as fontes que lemos não dão nenhum.
- Usar paginação por offset num feed que muda o tempo todo.
- Tratar o modelo de ranking como o único problema do 'feed' e ignorar a recuperação de candidatos.


---

## 🧒 Non-technical explanation

Um news feed é um **jornal personalizado** montado para cada leitor. Há duas formas de tocar a gráfica:

- **Imprimir na escrita:** quando alguém que você segue publica, a gráfica joga na hora uma cópia na **sua** caixa de correio. Ler é instantâneo, mas uma pessoa com dez milhões de seguidores significa que dez milhões de cópias são impressas no instante em que ela fala.
- **Juntar na leitura:** nada é pré-impresso. Quando você abre o jornal, um assistente sai correndo para coletar as novidades de todos que você segue. Escrever é barato, ler é lento.

Os serviços reais misturam os dois, e depois acrescentam um **editor** que escolhe, ranqueia e mistura recomendações de pessoas que você não segue.

---

## TL;DR for engineers

- **Dois trabalhos:** (1) **geração de candidatos**, encontrar posts que poderiam aparecer, e (2) **ranking e mixagem**, decidir a ordem. O primeiro é um problema de storage/fan-out e o segundo é um problema de ML/serving.
- O **fan-out on write** empurra cada novo post para os caches de timeline dos seguidores. O post do Twitter de 2017 nomeia um **Fanout Service** que escreve no **Haplo**, o cache primário das timelines de Tweets, apoiado por um Redis customizado (a **HybridList**) e lido pelo **Timeline Service** `[CONFIRMED]`.
- O **fan-out on read** calcula a timeline no momento da requisição a partir do grafo de seguidores. A mistura dos dois (um híbrido, com as contas de muitos seguidores tratadas na leitura) é a resposta padrão `[INDUSTRY PATTERN]`. Os posts que lemos não descrevem a regra exata do híbrido do Twitter.
- **Pipeline de ranking (Twitter 2023):** geração de candidatos → hidratação de features (~6.000 features) → pontuação por ML → filtros e heurísticas → mixagem com anúncios e módulos → serving `[CONFIRMED]` (README do Home Mixer).
- **Os IDs precisam ser ordenáveis por tempo e cientes do shard.** Instagram: **41 bits de tempo + 13 bits de shard lógico + 10 bits de sequência = 64 bits**, gerados dentro do Postgres `[CONFIRMED]`.
- **O caching é a camada que sustenta tudo:** no Twitter o cache é "~3% of our infrastructure" mas "critical" `[CONFIRMED]`.

---

## 1. Requirements (design framing)

**Funcionais:** postar · seguir/deixar de seguir · feed inicial (scroll infinito, itens novos no topo) · curtidas/respostas · notificações de novos posts (veja [10 Notification system](10-notification-system.md)).

**Não funcionais:** **latência de leitura** do feed (as leituras dominam) · disponibilidade · eventual consistency é aceitável (um post pode aparecer alguns segundos depois) · lidar com **skew**: poucas contas têm milhões de seguidores · custo de armazenar timelines por usuário.

**Abordagem de estimativa** `[SPECULATIVE]` (ilustrativa, declare suas próprias premissas): com 100M de usuários diários postando cerca de um item por dia, são 100M de posts/dia ≈ 1.157 posts/s. Se a conta média tem ~200 seguidores, o fan-out on write dá ≈ 1.157 × 200 ≈ 231 mil inserções de timeline por segundo em média, mas uma conta com 10M de seguidores causa uma rajada de 10M de escritas a partir de um único post, que é o problema do skew.

---

## 2. Fan-out strategies

| | **Fan-out on write (push)** | **Fan-out on read (pull)** | **Hybrid** |
|---|---|---|---|
| No post | Insere o ID do post no cache de timeline de cada seguidor | Guarda o post uma vez | Push para contas normais, sem push para contas de muitos seguidores |
| Na leitura | Lê uma lista pré-calculada | Consulta a lista de quem se segue, busca os posts recentes de cada um, faz merge e ordena | Lê a lista pré-calculada e depois faz merge dos posts recentes das contas grandes que você segue |
| Ponto forte | Leituras muito rápidas | Escritas baratas, sem trabalho desperdiçado para usuários inativos | Limita os dois |
| Ponto fraco | **Amplificação de escrita** para celebridades, trabalho desperdiçado para seguidores inativos | Leituras lentas e caras, thundering herd em contas populares | Dois caminhos de código e um limiar para ajustar |
| Evidência | O Twitter tem um **Fanout Service** escrevendo no cache de timeline **Haplo** `[CONFIRMED]` (2017) | Design geral `[INDUSTRY PATTERN]` | Design geral `[INDUSTRY PATTERN]`. O limiar exato do Twitter não está nas fontes que lemos |

Detalhes que valem dizer numa entrevista `[INDUSTRY PATTERN]`:
- Guarde **IDs de posts** nos caches de timeline, não posts completos. Hidrate-os a partir de um cache de posts na leitura, de modo que edições e deletes não exijam fan-out.
- Pule o fan-out para usuários **inativos** (não vistos há N dias) e monte as timelines deles sob demanda.
- Mantenha uma lista **limitada** por usuário (centenas de entradas). Os itens mais antigos vêm do caminho de pull.
- O fan-out é **assíncrono**: a chamada de post retorna rápido e uma fila alimenta os workers de fan-out.

### What Twitter's published infrastructure shows `[CONFIRMED]` (2017 post)
- O **Haplo** é "the primary cache for Tweet timelines and is backed by a customized version of Redis (implementing the HybridList). Haplo is read-only from Timeline Service and written to by Timeline Service and Fanout Service." Suas estatísticas na época: comandos agregados de 40M–100M por segundo e cerca de 800K requisições de serviço por segundo.
- Caches no geral: centenas de clusters, **320M pacotes/s**, mais de **120 GB/s** entregues, metas de latência nos percentis 99,9 e 99,99, clusters tratando **10M–50M QPS** cada. O post enfatiza que o cache "protects our backing stores from heavy read traffic and allows for storing objects which have heavy hydration costs".
- **Storage:** **Manhattan** (banco de dados distribuído multi-tenant em tempo real, lançado em abril de 2014) para Tweets, DMs e contas. Grafo social **Flock** em Gizzard/MySQL, "peaks over tens of million QPS" com média de 30k–45k QPS por servidor MySQL. **Blobstore** para mídia ("hundreds of billions objects", introduzido em dezembro de 2012 para uploads nativos de fotos). Serviço de IDs **Snowflake** desde junho de 2010.
- **Lições de operação:** milhares de conexões por instância de cache faziam com que restarts pudessem causar "DDoS-esque connect attacks", então eles fazem throttle das conexões para cada cache.

---

## 3. Ranking and mixing: Twitter's open-sourced pipeline `[CONFIRMED]` (2023)

O **Home Mixer** é "the main service used to construct and serve Twitter's Home Timelines", construído sobre o **Product Mixer**, um framework em Scala para construir feeds. Ele alimenta três timelines:
- **For You:** "best Tweets from people you follow + recommended out-of-network content".
- **Following:** posts em ordem cronológica reversa das contas que você segue.
- **Lists:** posts em ordem cronológica reversa dos membros de uma List.

**Estágios do pipeline do For You** (README do Home Mixer):
1. **Geração de candidatos**: busca Tweets de fontes de candidatos.
2. **Hidratação de features**: busca cerca de **6.000 features** usadas no ranking.
3. **Pontuação e ranking** com um modelo de ML.
4. **Filtros e heurísticas**: diversidade de autores, equilíbrio entre in-network e out-of-network, fadiga de feedback, deduplicação, filtro de visibilidade.
5. **Mixagem** com anúncios, módulos de quem seguir e prompts.
6. **Serving**: módulos de conversa, paginação, instruções ao cliente.

**Fontes de candidatos nomeadas:** o **Earlybird search index** ("Find and rank In-Network posts. ~50% of posts come from this candidate source"), **Tweet-mixer / Cr Mixer** (candidatos out-of-network), **UTEG** (um grafo de interação usuário–post em memória percorrido para obter candidatos) e o **Follow Recommendation Service**. Modelos nomeados no README principal: **Light Ranker** (dentro do search index), **Heavy Ranker** (rede neural), **SimClusters**, **TwHIN**, **RealGraph**, **Tweepcred**, mais modelos de Trust and Safety e filtros de visibilidade.

**Lição:** o feed inicial moderno não é "uma lista de posts de quem se segue". A maior parte do trabalho é **recuperação a partir de várias fontes e depois ranking**. O README não declara a fatia de out-of-network, nem diz qual backend o For You usa para candidatos in-network, então não declaramos nenhum dos dois.

---

## 4. IDs and sharding: Instagram `[CONFIRMED]` (2012 post)

O Instagram fez sharding do Postgres e precisava de IDs **ordenáveis por tempo**, de **64 bits** e baratos de gerar com poucas partes móveis. Considerou o Snowflake do Twitter e julgou que ele "came the closest", mas optou por evitar rodar um serviço de IDs separado.

- **Shards lógicos:** "several thousand 'logical' shards that are mapped in code to far fewer physical shards", cada shard lógico sendo um **schema do Postgres**. Mover um conjunto de shards lógicos para outro banco **não exige re-bucketing**.
- **Layout do ID:** **41 bits** de tempo em milissegundos (41 anos a partir de uma época customizada) + **13 bits** de ID de shard lógico + **10 bits** de sequência auto-increment por tabela mod 1024 (logo até **1024 IDs por shard por milissegundo**).
- **Gerado no Postgres** com uma função PL/pgSQL por schema, usando a sequência da própria tabela.
- **Exemplo do post:** sharding por ID de usuário com 2000 shards lógicos, usuário 31341 → shard 31341 % 2000 = 1341.
- **Por que importa para um feed:** ordenar IDs ordena por tempo, então uma lista de "últimos posts" não precisa de chave de ordenação extra, e o ID do shard está embutido, de modo que dá para achar o shard só pelo ID.

Compare com o layout do Snowflake do Twitter (41 de tempo + 10 de worker + 12 de sequência, veja [01 URL shortener](01-url-shortener.md)).

---

## 5. A reference architecture `[INDUSTRY PATTERN]`

```
Post API ─► post store (sharded) ─► fan-out queue ─► fan-out workers ─► timeline cache (per user, post IDs)
                                         ▲                    │
                follow graph store ──────┘ (who are the followers?)
Feed read: Feed API ─► timeline cache ─► hydrate posts + authors (cache) ─► rank/mix ─► page + cursor
                          └─► merge pull-path posts from high-follower accounts
```

Escolhas a declarar: **paginação por cursor** (não por offset), já que novos posts chegam o tempo todo · **fan-out idempotente** (um worker repetido não pode duplicar entradas) · **degradação graciosa** (servir uma timeline em cache desatualizada se o ranking estiver fora) · **deletes e bloqueios** aplicados na leitura por meio da hidratação.

---

## ⚠️ Reviewer notes

1. **"O Twitter usa fan-out on write" é metade da história.** O post de 2017 confirma um Fanout Service e um cache de timeline, mas a regra híbrida para contas de muitos seguidores é conhecimento comum de palestras mais antigas, e não conseguimos verificá-la numa fonte primária nesta sessão. Não declare um limiar de seguidores.
2. **A arquitetura de feed do Instagram não é descrita no que lemos.** Apenas o esquema de IDs e sharding (2012) é. A afirmação popular de que o Instagram roda "fan-out on write" de uma forma particular não estava nas fontes que lemos.
3. **A liberação do código em 2023 é um retrato do ranking, não do storage.** Ela diz como os candidatos são gerados e pontuados. Não descreve o design do cache de timeline, então não misturamos as duas coisas.
4. **Os números envelhecem.** Os números de cache e QPS de 2017 descrevem aquele ano. Os números do Instagram de 2012 (25 fotos e 90 curtidas por segundo) descrevem o Instagram na escala de lançamento.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance** (latência de leitura do feed), **escalabilidade**, **elasticidade** em torno de eventos, **disponibilidade** e **custo** (storage de timelines e computação de fan-out). A consistência é deliberadamente relaxada.
- **Estilo (Ch 14/17):** um caminho de escrita **event-driven** (post → fila → workers de fan-out) e um caminho de leitura **service-based / microsserviços** (Timeline Service, hidratadores, mixers de ranking). O pipeline de fontes, pontuadores e filtros do Product Mixer é, ele próprio, uma pequena arquitetura de pipeline (Ch 11).
- **Quanta (Ch 7):** o fan-out do lado da escrita e o serving do lado da leitura são quanta separados. Se o fan-out atrasa, as leituras continuam funcionando, só mais desatualizadas.
- **Trade-off (First Law, Ch 1):** **amplificação de escrita vs latência de leitura.** O híbrido existe porque nenhuma das estratégias puras serve para contagens de seguidores com skew.
- **Esboço de ADR (Ch 19):** *"Vamos fazer fan-out de IDs de posts na escrita para contas abaixo de um limiar de seguidores e fazer merge das contas de muitos seguidores na leitura. Aceitamos dois caminhos de código para limitar a amplificação de escrita."*
- Em linguagem simples: imprima uma cópia para cada leitor quando o autor é pequeno e, para as superestrelas, deixe o assistente do leitor buscar a página mais recente sob demanda.

---

## Interview questions to practice

1. Projete um feed inicial para 100M de usuários diários. Push, pull ou híbrido, e por quê?
2. Um usuário com 20M de seguidores posta. O que acontece com a sua fila de fan-out? Como evitar prejudicar a latência de todos os outros?
3. Como paginar um feed de scroll infinito enquanto chegam novos posts? Por que não paginação por offset?
4. Como gerar IDs que ordenam por tempo em 4.000 shards? Compare o layout do Instagram com um serviço de IDs central.
5. Onde entra o ranking? Quais são as fontes de candidatos, e por que mais de uma?
6. Um usuário apaga um post. Como ele some das timelines em cache dos seguidores?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: grafo de seguidores, ranking, frescor, mídia.
2. Estimar: posts/s × média de seguidores.
3. API: postar, feed inicial com um cursor.
4. Design: post store, fan-out service, cache de timeline, hidratação.
5. Deep dive: push vs pull vs híbrido, pipeline de ranking.
6. Falhas e escala: posts de celebridades, perda de cache, usuários inativos.

**Se crescer 10×**
- Contas de celebridades: pule o fan-out e faça o merge na leitura.
- Memória de cache: limite o tamanho das timelines e pule os usuários inativos.
- Custo do ranking: use um light ranker antes do pesado.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Um usuário com 20M de seguidores posta. O que acontece?</summary>

Não faça fan-out para todos os seguidores. Marque a conta como pull-on-read e faça o merge de seus posts recentes no feed de cada leitor na hora da leitura, para que um post não crie uma rajada de 20M de escritas.

</details>

<details><summary>Por que paginação por cursor?</summary>

Novos posts chegam durante a rolagem, então os offsets se deslocam e duplicam ou pulam itens. Um cursor se ancora num item ou ID.

</details>

<details><summary>Como um delete some das timelines em cache?</summary>

As timelines guardam apenas IDs. A hidratação consulta o post store, então um post apagado sai na hora da leitura sem fan-out.

</details>

## 📚 Further reading

- As três fontes listadas no topo.
- [Facebook TAO paper](https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson) e *Timelines at Scale* de Raffi Krikorian (não lidos nesta sessão).
- [System Design Primer: Twitter timeline and search](https://github.com/donnemartin/system-design-primer) (secundária; enquadramento de entrevista).
- Relacionado neste repositório: [`neokim-post/10` Twitter timeline (front-end)](https://github.com/allmonty/study/blob/main/architecture/neokim-post/10-how-twitter-timeline-works.md) (o lado do cliente do mesmo produto), [01 URL shortener](01-url-shortener.md) (Snowflake IDs), [03 Distributed KV store](03-distributed-kv-store.md) (consistent hashing, replicação).

## Sources and provenance

> **Kind:** reference design ancorado em fatos de real-system. Nem o Twitter/X nem o Instagram publicam um documento completo de "como o feed funciona". Esta nota combina o que cada um *de fato* publicou e verificou: o post de infraestrutura do Twitter (2017) e seu código de recomendação aberto (2023), e o post de sharding e IDs do Instagram (2012). As estratégias de fan-out são o design padrão `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:**
> · Twitter Engineering, *The Infrastructure Behind Twitter: Scale* (2017-01-19; a [URL original](https://blog.x.com/engineering/en_us/topics/infrastructure/2017/the-infrastructure-behind-twitter-scale) devolveu 403, então lemos a cópia da mesma página no Internet Archive)
> · [twitter/the-algorithm README](https://github.com/twitter/the-algorithm) e [Home Mixer README](https://github.com/twitter/the-algorithm/tree/main/home-mixer) (liberação de código aberto de 2023)
> · Instagram Engineering, [*Sharding & IDs at Instagram*](https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c) (2012-12-30; o site no ar recusou nossa conexão, então lemos a cópia do Internet Archive)
> **Not read:** o post *Thundering Herds & Promises* do Instagram (bloqueado com 403), a palestra *Timelines at Scale* de Raffi Krikorian (a página do InfoQ tinha um resumo, sem transcrição), o paper TAO do Facebook. As afirmações que dependem deles são `[INDUSTRY PATTERN]`.
> **Dated material:** Instagram 2012, infraestrutura do Twitter 2017, código de ranking do Twitter 2023. Todos mudaram desde então.
> **Tags:** `[CONFIRMED]` afirmado pela fonte primária · `[INDUSTRY PATTERN]` prática padrão, não declarada pela fonte · `[SPECULATIVE]` plausível.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* Twitter infrastructure post and Instagram post read from Internet Archive copies of the original pages. Twitter code READMEs read from GitHub.
- Verified (Twitter 2017): date; Haplo as primary Tweet-timeline cache on customised Redis with HybridList, read-only for Timeline Service and written by Timeline Service and Fanout Service, plus its stats; cache is ~3% of infrastructure; cache aggregate figures (320M packets/s, 120 GB/s, 10M–50M QPS per cluster, 99.9th/99.99th latency goals); Manhattan (April 2014), Flock peaks and per-server QPS, Blobstore (December 2012) and Snowflake (June 2010); connection-throttling lesson.
- Verified (the-algorithm READMEs): Home Mixer role, Product Mixer, For You / Following / Lists; six pipeline stages; ~6,000 features; filters list; mixing with ads and modules; candidate sources and the "~50% of posts come from this candidate source" statement; Light Ranker, Heavy Ranker and supporting models.
- Verified (Instagram 2012): date, "25 photos and 90 likes every second", Django + PostgreSQL, thousands of logical shards on few physical ones, Postgres schemas as logical shards, 41/13/10 bit layout, 1024 IDs per shard per millisecond, PL/pgSQL generation, Snowflake judged closest but avoided, the 31341 % 2000 = 1341 example (re-derived by hand).
- Removed: Twitter's follower threshold for hybrid fan-out, the claim that Instagram's feed uses a particular fan-out strategy, and the Thundering Herds post's contents. None was available from a source we could read.
- Scoped: the estimation figures are illustrative (`[SPECULATIVE]`), and the reference architecture and fan-out table rows other than Twitter's Fanout Service are `[INDUSTRY PATTERN]`.
- Method note: the Twitter and Instagram posts were read through the Internet Archive (the originals were blocked from this environment). We did not compare them against the originals.
- Quote audit (2026-10-27): the Instagram "logical shards" quote now matches the post verbatim ("that are mapped in code").
