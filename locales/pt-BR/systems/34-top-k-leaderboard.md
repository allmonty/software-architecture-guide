# 34 — Top-K, Heavy Hitters and Leaderboards

*Design de referência construído sobre dois blocos publicados: sorted sets do Redis para ranking exato e o algoritmo Space-Saving para heavy hitters aproximados em streams. Como foi pesquisado e o que não foi verificado está em **Sources and provenance** ao final.*

## At a glance

**Em 60 segundos.** Duas perguntas parecem iguais, mas exigem designs diferentes. Um **leaderboard** (*quem são os 100 melhores jogadores e qual é a minha posição?*) precisa de pontuações exatas e ordenadas que mudam constantemente. Uma pergunta de **heavy-hitters / top-K** (*quais 10 consultas de busca ou vídeos são mais populares na última hora?*) percorre um stream de eventos cujo conjunto de itens distintos é grande demais para ser contado exatamente. Para o primeiro, use uma estrutura ordenada (uma skip list em um sorted set, O(log N) por atualização) e distribua em shards quando ultrapassar um nó. Para o segundo, mantenha um conjunto limitado de contadores (Space-Saving) por janela e mescle resultados parciais. Janelas, particionamento e a precisão que você promete são o foco da entrevista.

**Números-chave** (conforme publicado)
- As operações de sorted set do Redis são em sua maioria O(log n); um ZADD em um membro existente atualiza sua pontuação e posição em O(log n), e `ZRANGE` é O(log n + m) para m resultados retornados `[CONFIRMED]`.
- Space-Saving monitora apenas um número fixo m de elementos, e para dados reais com distribuição Zipfiana, o espaço necessário para o problema de elementos frequentes diminui drasticamente conforme a inclinação aumenta `[CONFIRMED]`; foi motivado por streams de cliques em anúncios na Internet `[CONFIRMED]`.

**Decisões e trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Conjunto ordenado exato (sorted set) para leaderboards | Consultas de rank e intervalo são baratas e exatas | Todos os dados em memória em um único nó até o sharding |
| Contadores aproximados (Space-Saving) para streams | Memória limitada independentemente dos itens distintos | Contagens têm erro limitado; ranks próximos ao corte podem estar errados |
| Janelas tumbling com buckets mesclados | Expiração simples de dados antigos | Janelas são grosseiras; mesclar adiciona erro |
| Shard por item (chave) | A contagem de cada item fica em um único lugar | Itens quentes; top-K precisa de uma mesclagem final |
| Cache do resultado top-K | Leituras são muito frequentes | Desatualização |

**Erros comuns**
- Ordenar todos os itens para cada consulta.
- Mesclar listas top-K por shard quando os itens estão divididos entre shards por *evento* em vez de por chave: um item que não está no top K de nenhum shard pode ainda ser top K globalmente.
- Prometer contagens exatas a partir de uma estrutura aproximada.
- Esquecer a expiração: "top na última hora" precisa de janelas ou decaimento.

---

## 🧒 Non-technical explanation

Um **leaderboard** é um placar em uma pista de boliche: cada pontuação é registrada, o placar permanece ordenado e qualquer pessoa pode perguntar "qual é a minha posição?". Heavy hitters são diferentes: imagine contar os itens mais populares passando por uma esteira em uma fábrica onde há itens distintos demais para manter uma contagem para cada um. Você tem um pequeno bloco de notas com um número fixo de linhas. Quando um item desconhecido chega e o bloco está cheio, você risca o item com a menor contagem e reutiliza sua linha, lembrando que a contagem do novo item pode estar superestimada em no máximo essa contagem. Ao final, as maiores contagens no bloco são os itens populares, e você sabe o quanto cada uma pode estar errada.

---

## TL;DR for engineers

- **Leaderboard exato:** sorted set (skip list + hash table), atualização e rank O(log N) `[CONFIRMED]` (documentação do Redis).
- **Top-K aproximado sobre um stream:** Space-Saving com um número fixo de contadores `[CONFIRMED]` (Metwally et al.).
- **Janelas:** buckets de tempo tumbling ou sliding, mesclados na consulta `[INDUSTRY PATTERN]`.
- **Scale-out:** particionar por chave, computar resumos locais, mesclar `[INDUSTRY PATTERN]`.
- **Serving:** cache do resultado com TTL curto `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcional:** atualizar uma pontuação ou contagem · obter o top K · obter o rank de um membro (leaderboard) · escopo por janela de tempo (última hora, hoje, todo o período) · escopo por categoria ou região.

**Não-funcional:** **baixa latência de atualização** em altas taxas · **leituras rápidas** do top K · **memória limitada** · **alvo de precisão** (exato para leaderboard, erro limitado para streams) · **disponibilidade**.

**Perguntas de esclarecimento:** exato ou aproximado? Tamanho da janela? Número de itens distintos e taxa de atualização? O top K é por categoria? Qual a frequência mínima de atualização dos resultados? Empates são desfeitos, e como?

---

## 2. Exact ranking: the sorted set `[CONFIRMED]` (Redis documentation)

Os sorted sets do Redis armazenam membros únicos com uma pontuação numérica e os mantêm ordenados; a documentação diz que a implementação usa "a skip list and a hash table", portanto cada adição custa O(log N) e "when we ask for sorted elements, Redis does not have to do any work at all, it's already sorted". Chamar ZADD em um membro existente atualiza sua pontuação e posição em O(log N), então "sorted sets are suitable when there are tons of updates", e leaderboards são citados como o caso de uso comum: usuários ordenados por pontuação máxima, com get-rank (`ZRANK`/`ZREVRANK`), para exibir o top N e a posição do próprio usuário. A maioria das operações é O(log n); `ZRANGE` é O(log n + m) para m resultados retornados, portanto evite solicitar dezenas de milhares de uma vez. O Redis também lista rate limiters de janela deslizante como uso de sorted sets (compare [02 Rate limiter](02-rate-limiter.md)).

**Limites (nosso raciocínio `[INDUSTRY PATTERN]`):** um sorted set vive na memória de um único nó e é atualizado por uma única thread, portanto um leaderboard com centenas de milhões de membros ou uma taxa de atualização muito alta precisa de sharding (abaixo).

---

## 3. Approximate heavy hitters: Space-Saving `[CONFIRMED]` (Metwally, Agrawal, El Abbadi, ICDT 2005)

O artigo aborda como encontrar os k elementos mais populares e os elementos frequentes em um stream de dados. Ele afirma que a técnica é eficiente e exata quando o alfabeto é pequeno, e que para o caso prático de alfabeto grande é eficiente em espaço e "reports both top-k and frequent elements with tight guarantees on errors". A ideia: monitorar apenas **m** elementos por vez, manter contadores para estimar com precisão as frequências dos elementos significativos, e usar uma estrutura leve (Stream-Summary) que mantém os elementos ordenados por frequência estimada. Para distribuições gerais, sua resposta top-k pode ser um conjunto de k' ≈ k elementos garantidamente no top-k'; para dados reais com distribuição Zipfiana, o requisito de espaço do problema de elementos frequentes diminui drasticamente com a inclinação, e para consultas top-k garante que apenas os elementos top-k sejam reportados, na ordem correta. Os autores foram motivados por comissários de publicidade na Internet, que recebem streams de renderizações de anúncios, cliques, vendas e leads, e precisam de resumos desses streams rapidamente; veja [31 Ad click aggregation](31-ad-click-aggregation.md).

**Como funciona (algoritmo do artigo, parafraseado):** manter m pares (item, contagem). Se um item chegando já é monitorado, incrementar sua contagem. Se não, substituir o item com a menor contagem pelo novo item, definir sua contagem como esse mínimo mais um, e registrar o mínimo como o possível excesso de contagem. As contagens são, portanto, limites superiores, e o erro registrado indica o quanto cada uma pode estar errada.

O Count-Min Sketch (Cormode e Muthukrishnan) é outra estrutura amplamente utilizada para frequências aproximadas; não conseguimos recuperar seu artigo e não fazemos afirmações sobre ele.

---

## 4. Reference design `[INDUSTRY PATTERN]`

```
events ─► partition by item id ─► per-partition counters (exact map or Space-Saving) per time bucket
                                         │ periodic local top-K (with error bounds)
                                         ▼
                          merge service ─► global top-K per window ─► cache ─► API
leaderboard: score updates ─► sharded sorted sets ─► top-N via merge, rank via counts above
```

- **Janelas.** Para "última hora", manter um bucket por minuto e descartar buckets com mais de 60 minutos; a resposta é a mesclagem dos 60 buckets. Para "todo o período", manter uma estrutura contínua. Para decaimento suave, usar contagens com ponderação exponencial.
- **Particionar por item, não por evento.** Se eventos do mesmo item vão para o mesmo shard, o top-K de cada shard é exato para seus itens e o top-K global é o top-K da união das listas dos shards. Se eventos forem distribuídos aleatoriamente, é preciso mesclar contagens por item antes de ranquear, pois um item pode ficar abaixo do corte de cada shard individualmente, mas ultrapassá-los no total.
- **Mesclar.** Coletar os top (K + margem) de cada shard com contagens, somar contagens do mesmo item, ordenar. Com contadores aproximados, carregar os limites de erro.
- **Sharding do leaderboard.** Particionar por faixa de pontuação (rank = número de membros em faixas superiores mais o rank dentro da faixa) ou por hash do membro (top-N via mesclagem do top N de cada shard; o rank global de um membro precisa de contagens de todos os shards ou uma aproximação). Combinar com um snapshot periódico para "minha posição" em escala muito grande.
- **Empates e justiça.** Definir o critério de desempate (timestamp anterior tem prioridade) e codificá-lo na chave de ordenação.
- **Serving.** Cache do top-K para cada escopo com TTL de segundos; computar periodicamente em vez de por requisição.
- **Durabilidade.** Persistir pontuações em um banco de dados; reconstruir a estrutura em memória ao reiniciar; registrar eventos para recomputação.
- **Abuso.** Leaderboards convidam a trapaças: validar atualizações de pontuação no servidor (veja [21 Game matchmaking](21-game-matchmaking-lobby-chat.md), [P06](../toolkit/P06-security-threat-modeling.md)).

---

## 5. Failure scenarios

- **Um shard falha.** Seus itens ficam ausentes do top-K até o failover; servir o resultado em cache e marcá-lo como desatualizado `[INDUSTRY PATTERN]`.
- **Um item quente.** Uma chave recebe a maioria dos eventos; dividir o contador entre sub-chaves e somar na leitura `[INDUSTRY PATTERN]`.
- **Janelas distorcidas.** Eventos atrasados alteram buckets antigos; definir uma política de atraso (veja [31](31-ad-click-aggregation.md)) `[INDUSTRY PATTERN]`.
- **Erro aproximado no corte.** Itens próximos ao rank K podem estar fora de ordem; expor isso, ou verificar candidatos exatamente `[CONFIRMED]` em princípio (o algoritmo fornece limites), a política é nossa.
- **Leituras em rajada.** Cache do resultado e atualização em segundo plano (veja [32 Distributed cache](32-distributed-cache.md)) `[INDUSTRY PATTERN]`.

---

## 6. Capacity reasoning (illustrative)

- **Memória para contagem exata** ≈ itens distintos × (chave + contagem). 1 bilhão de consultas distintas × 40 bytes ≈ 40 GB por janela, grande demais para manter em 60 buckets de um minuto; Space-Saving com, digamos, 100.000 contadores por bucket por shard tem alguns megabytes. Ambos os números são nossas estimativas.
- **Memória do leaderboard** em um sorted set ≈ membros × (id do membro + pontuação + overhead da skip list); com 100 milhões de membros a aproximadamente 100 bytes cada, são cerca de 10 GB, o que cabe em um nó grande, mas sem folga, portanto planeje shards.
- **Taxa de atualização:** 50.000 atualizações de pontuação por segundo está ao alcance de um nó em memória para atualizações simples; planeje sharding e réplicas além disso (estimativa).

---

## ⚠️ Reviewer notes

1. **A descrição do algoritmo Space-Saving na seção 3** ("how it works") parafraseia o algoritmo apresentado no artigo (substituir o elemento com a contagem mínima, contagem = mínimo + 1, erro = o mínimo); o texto do PDF do artigo perdeu o espaçamento entre palavras ao ser extraído, portanto citamos apenas suas afirmações em nível de resumo.
2. **A documentação do Redis descreve o Redis,** não leaderboards em geral; estratégias de sharding são nossas.
3. **Count-Min Sketch não é coberto:** não conseguimos recuperar seu artigo.
4. **Not read:** documentação do Redis Cluster, artigos sobre Frequent/Lossy Counting, literatura sobre decaimento temporal e post-mortems de leaderboards em produção.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não proveniente das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características determinantes (Ch 4–5):** **performance**, **escalabilidade**, **precisão (limitada)**, **custo** (memória).
- **Estilo (Ch 13):** um **pipeline** de sumarizadores particionados alimentando um serviço de mesclagem e um cache de leitura.
- **Quanta (Ch 7):** os sumarizadores escalam independentemente do nível de leitura; o ponto de mesclagem é o custo de coordenação.
- **Trade-off (First Law, Ch 1):** **precisão vs memória.** Contagens exatas custam memória proporcional aos itens distintos; resumos com erro limitado oferecem memória constante.
- **ADR sketch (Ch 19):** *"We will use per-minute Space-Saving summaries partitioned by item, merged into hourly top-K, and cache the result for ten seconds. We accept bounded error near the cut-off in exchange for constant memory."*
- Em linguagem simples: um bloco de notas com um número fixo de linhas, mesclado a cada minuto.

---

## Interview questions to practice

1. Projete um sistema que mostre as 10 buscas mais populares na última hora.
2. Projete um leaderboard para um jogo com 100 milhões de jogadores, incluindo a posição de cada jogador.
3. Como você mantém a memória limitada quando há bilhões de itens distintos?
4. Por que mesclar listas top-K por shard pode estar errado, e como você evita isso?
5. Como você lidaria com uma janela que desliza continuamente?
6. Qual precisão você pode garantir com um contador aproximado?
7. Como você lida com empates e trapaças?

## Interview practice

Estes esboços são nosso próprio raciocínio (`[INDUSTRY PATTERN]`), não afirmações das fontes.

**Um roteiro de 45 minutos**

1. Esclarecer: exato ou aproximado, janela, escopos, taxa de atualização, itens distintos.
2. Estimar: eventos por segundo, itens distintos, memória por abordagem ([P01](../toolkit/P01-estimation.md)).
3. API: registrar evento ou pontuação, obter top K, obter rank.
4. Design: particionar por item, resumos por bucket, serviço de mesclagem, cache; ou sorted sets com sharding para leaderboards.
5. Aprofundamento: Space-Saving e erro, tratamento de janelas, correção da mesclagem, chaves quentes.
6. Falha e escala: perda de shard, eventos atrasados, taxa de eventos 10×, trapaças.

**Se crescer 10×**
- Mais partições e uma mesclagem em dois níveis; manter K pequeno e empurrar a filtragem para baixo.
- Substituir mapas exatos por resumos aproximados; encurtar janelas.
- Consultas de rank migram para ranks aproximados (percentil) para a maioria dos jogadores.

**Esboços de resposta** (tente as perguntas acima primeiro)

<details><summary>Why can per-shard top-K merging be wrong?</summary>

Se os eventos de um item estão divididos entre shards, sua contagem em cada shard pode ser pequena demais para aparecer no top-K daquele shard, mesmo que o total seja grande. Particione por item para que todos os eventos de um item se encontrem em um único shard, ou peça a cada shard mais do que K candidatos e mescle contagens exatas por item, e informe o erro restante.

</details>

<details><summary>How do you keep memory bounded with billions of distinct items?</summary>

Mantenha um número fixo de contadores por janela com um algoritmo de stream-summary como Space-Saving: monitore apenas os itens pesados, substitua o menor contador quando um novo item chegar e mantenha um limite de erro por item. A memória depende do número de contadores, não dos itens distintos.

</details>

<details><summary>How do you give a player their rank in a sharded leaderboard?</summary>

Com shards por faixa de pontuação, o rank é o número de membros em faixas superiores mais o rank dentro do shard do jogador. Com shards por hash, some a contagem de membros com pontuação maior de cada shard (uma consulta de contagem por shard), ou forneça um percentil aproximado a partir de snapshots periódicos.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [31 Ad click aggregation](31-ad-click-aggregation.md), [30 Metrics monitoring](30-metrics-monitoring-alerting.md), [21 Game matchmaking and lobby chat](21-game-matchmaking-lobby-chat.md), [32 Distributed cache](32-distributed-cache.md), [20 Web crawler and search](20-web-crawler-search.md).

## Sources and provenance

> **Kind:** reference design built on published building blocks `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Redis documentation, [Sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) · Metwally, Agrawal and El Abbadi, [*Efficient Computation of Frequent and Top-k Elements in Data Streams*](https://www.cse.ust.hk/~raywong/comp5331/References/EfficientComputationOfFrequentAndTop-kElementsInDataStreams.pdf) (ICDT 2005; PDF text extracted locally, with word spacing lost in places).
> **Dated material:** the paper is from 2005; the Redis page as of 2026-10-27.
> **Not read:** o artigo do Count-Min Sketch, a documentação do Redis Cluster, outros artigos sobre resumos de streaming e post-mortems de produção.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Redis page: skip list plus hash table, O(log N) adds and score updates, pre-sorted retrieval, leaderboard use case and rank commands, ZRANGE complexity, the sliding-window rate limiter mention.
- Verified in the Space-Saving paper (abstract and introduction): exactness for small alphabets, space efficiency and error guarantees for large alphabets, monitoring of m elements, the k' ≈ k property, Zipfian space reduction, the advertising motivation.
- Verified in the paper's algorithm figure: replacement of the minimum counter with count = minimum + 1 and error = the minimum (paraphrased).
- Not sourced (our reasoning): the reference design, sharding strategies and capacity arithmetic.
- Not claimed: behaviour of Redis Cluster or any production leaderboard.
