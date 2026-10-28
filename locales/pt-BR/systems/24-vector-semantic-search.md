# 24 — Vector / Semantic Search at Scale

*Um reference design construído sobre três designs de índice publicados (HNSW, DiskANN, Faiss). Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** A semantic search transforma itens (documentos, imagens, produtos) em vetores e encontra os mais próximos de um vetor de consulta. A busca exata compara a consulta com todos os vetores, o que não escala, então os sistemas de produção usam índices de **approximate nearest neighbour (ANN)** que trocam um pouco de recall por muita velocidade. As principais famílias são índices de grafo (HNSW), índices em clusters com vetores comprimidos (IVF com product quantization, como no Faiss) e grafos residentes em SSD (DiskANN). Em escala você também faz shard do índice, filtra por metadados, absorve escritas novas e reconstrói quando o modelo de embedding muda. O trade-off central é **recall versus latência versus memória**.

**Números principais** (como publicados, nos testes dos autores)
- O DiskANN indexa e serve uma base de um bilhão de pontos numa única máquina com 64 GB de RAM e um SSD, a mais de 5.000 consultas por segundo com latência média abaixo de 3 ms e 1-recall@1 de 95%+ no SIFT1B `[CONFIRMED]` (NeurIPS 2019).
- O mesmo paper diz que índices de vetores comprimidos com pequena pegada de memória chegam a apenas cerca de 0,5 de 1-recall@1, porque a compressão tem perdas `[CONFIRMED]`.
- Um exemplo de produção relatado fez sharding de 2 bilhões de pontos de 128 dimensões em 32 máquinas, consultando todos os shards e agregando, para um 100-recall@100 de 0,98 em cerca de 5 ms `[CONFIRMED]` (citado no paper do DiskANN, referenciando outra fonte).
- A complexidade de busca do HNSW escala logaritmicamente, e uma faixa razoável do seu parâmetro de conexão M é de 5 a 48, com a memória proporcional a M `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Índice de grafo em RAM (HNSW) | Melhor velocidade com recall alto | Memória para vetores mais arestas do grafo |
| Vetores comprimidos (product quantization) | Cabem muito mais vetores em RAM | Com perdas: recall menor, a menos que se refaça a pontuação |
| Grafo residente em SSD (DiskANN) | 5–10× mais pontos por nó que grafos em memória | Algumas dezenas de leituras aleatórias de SSD por consulta para engenheirar |
| Shard e fan out | Capacidade além de uma máquina | Toda consulta atinge todos os shards; latência de cauda do shard mais lento |
| Filtrar durante a busca | Condições de metadados são comuns | O filtro pode prejudicar o recall ou a velocidade se feito de forma ingênua |

**Erros comuns**
- Citar "recall" sem dizer em qual k. 1-recall@1 e 100-recall@100 são barras muito diferentes.
- Dimensionar só pelos bytes dos vetores e esquecer o overhead do grafo ou do índice.
- Escolher um índice antes de medir o recall nos seus próprios embeddings; os resultados dependem dos dados.
- Esquecer que trocar o modelo de embedding muda todos os vetores, então o índice inteiro precisa ser reconstruído.

---

## 🧒 Non-technical explanation

Imagine uma **biblioteca enorme em que os livros são organizados por sentido, não por título**: livros de culinária perto de outros livros de culinária, mas também "viagem pela Itália" perto de "comida italiana". Achar o livro mais próximo de uma pergunta comparando-a com todos os livros levaria uma eternidade. Então a biblioteca mantém um **mapa de atalhos**: de qualquer livro você pode pular para alguns vizinhos próximos, e alguns pulos de longa distância deixam você cruzar o prédio rápido. Você começa num ponto de referência, continua pulando em direção à pergunta e para quando nenhum vizinho está mais perto. Pode ser que de vez em quando você perca o melhor livro absoluto, mas acha um muito bom em uma dúzia de pulos.

---

## TL;DR for engineers

- A **busca de vizinho mais próximo exata** é uma varredura linear. Os índices ANN abrem mão de parte do recall por velocidade `[CONFIRMED]`.
- **HNSW:** um grafo de proximidade multicamada; a camada de topo de cada elemento é escolhida aleatoriamente com probabilidade que decai exponencialmente; a busca começa na camada de topo e desce `[CONFIRMED]`.
- **IVF mais product quantization (Faiss):** agrupe os vetores em clusters, busque apenas nos clusters mais próximos e guarde códigos comprimidos `[CONFIRMED]`.
- **DiskANN:** um grafo (Vamana) e os vetores completos no SSD, vetores comprimidos na RAM, beam search para cortar idas e vindas ao SSD `[CONFIRMED]`.
- **Sharding, filtragem, frescor e reindexação** são as preocupações da plataforma `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** inserir e atualizar vetores com ids e metadados · consultar por vetor ou texto e devolver os k mais próximos · filtrar por metadados · apagar.

**Não funcionais:** **latência** (de um dígito a dezenas de milissegundos) · metas de **recall** · **escala** (de milhões a bilhões de vetores) · **frescor** das escritas novas · **custo** (a memória domina) · **disponibilidade** · **throughput**.

**Perguntas de esclarecimento:** número de vetores e de dimensões? Taxa de consultas e meta de latência? Recall exigido, e em qual k? Quão frescos os itens novos precisam ser? Que filtros são necessários? Com que frequência o modelo de embedding muda? Os dados são multi-tenant?

---

## 2. Why exact search fails, and what ANN trades `[CONFIRMED]`

O paper do Faiss (Douze et al., arXiv 2401.08281) descreve a vector search como a função central dos bancos de dados vetoriais e a descreve como um conjunto de **trade-offs** entre acurácia, tempo de busca, uso de memória, tempo de construção do índice e, para armazenamento flash ou distribuído, o número de operações de I/O.

O paper do DiskANN coloca de forma direta: "it is often impossible to retrieve the exact nearest neighbors without essentially resorting to a linear scan of the data", por causa da maldição da dimensionalidade, então os sistemas recuperam vizinhos aproximados e medem o **k-recall@k**: a fração dos k vizinhos mais próximos verdadeiros que a busca devolve.

**Escolha da métrica.** O paper do Faiss mostra como reduzir a distância L2, o produto interno e a similaridade de cosseno uns aos outros pré-processando os vetores, de modo que um tipo de índice pode servir várias métricas. Para o cosseno, normalize os vetores.

---

## 3. Index families

### 3.1 HNSW: a layered proximity graph `[CONFIRMED]` (Malkov and Yashunin)

O índice Hierarchical Navigable Small World é "fully graph-based", com uma estrutura multicamada de grafos de proximidade sobre subconjuntos aninhados dos elementos. A camada máxima de cada elemento é escolhida aleatoriamente com probabilidade que decai exponencialmente, então as camadas superiores são esparsas. A busca começa na camada de topo e se move de forma gulosa em direção à consulta, descendo camadas; isso dá uma **escala de complexidade logarítmica**, e os autores notam a semelhança com uma **skip list**. Uma heurística para escolher os vizinhos de cada elemento melhora o desempenho com recall alto e em dados agrupados em clusters.

**Parâmetros.** O parâmetro de construção voltado ao usuário é o M (conexões por elemento); os autores sugerem de 5 a 48, M menor para recall menor ou dados de menos dimensões e M maior para recall alto ou dados de muitas dimensões. O uso de memória é proporcional a M. Um tamanho de lista de candidatos na construção (efConstruction) deve ser grande o bastante para um recall próximo de 1 durante a construção, e um tamanho de lista na busca (ef) controla o recall e a velocidade das consultas.

**O que o paper não nos dá.** Seu foco é a busca e a inserção. Não encontramos um procedimento de exclusão no texto que lemos, então não fazemos nenhuma afirmação sobre como apagar de um grafo HNSW além do que outras fontes afirmam.

### 3.2 IVF and product quantization (Faiss) `[CONFIRMED]`

**Inverted file (IVF).** Os vetores do banco são agrupados com um coarse quantizer, e os vetores de cada cluster são guardados em inverted lists. Na hora da busca só um subconjunto dos clusters é visitado (a configuração `nprobe`): os com os centroides mais próximos. Visitar mais listas aumenta o recall e o custo.

**Compressão.** A product quantization comprime os vetores em códigos curtos para que caibam muito mais na memória, ao preço da acurácia; o paper do Faiss a apresenta como algo que muitas vezes dá um bom trade-off entre tamanho do código e acurácia. O paper do DiskANN relata que essa classe de método tem uma pegada pequena (menos de 64 GB para um bilhão de pontos de 128 dimensões) e responde em menos de 5 ms com aceleradores, mas seu 1-recall@1 é bem baixo (cerca de 0,5) porque a compressão tem perdas. Um recall maior só aparece para a medida mais fraca de 1-recall@100 (o vizinho mais próximo verdadeiro aparece em algum lugar entre 100 candidatos), uma medida que o paper diz "may not be acceptable in many applications".

**Escopo da biblioteca.** O Faiss se descreve como um toolkit, não um serviço ou banco de dados: ele "does not provide concurrent write access, load balancing, sharding, transaction management or query optimization". Ele suporta adicionar e remover vetores por id, e busca filtrada por um predicado sobre ids, mas "does not store arbitrary metadata with the vectors". Filtrar por metadados significa, portanto, uma indireção para uma tabela de metadados separada ou empacotar atributos pequenos em bits de id não utilizados. Quando a distribuição dos dados muda substancialmente, estruturas de índice como o IVF e a compressão se degradam e precisam de atualizações explícitas.

### 3.3 DiskANN: a billion points on one machine `[CONFIRMED]` (Subramanya et al., NeurIPS 2019)

**Problema.** Os índices de grafo em memória são caros. O exemplo do paper: um índice NSG para 100 milhões de vetores float de 128 dimensões precisa de cerca de 75 GB (supondo um grau de grafo de 50), então um bilhão de pontos exige várias máquinas. As abordagens de sharding roteiam toda consulta para todo shard e agregam; o paper cita uma implantação relatada do Taobao com 2 bilhões de pontos em 32 shards.

**Design.** O DiskANN constrói um grafo **Vamana** e guarda "the graph along with the full-precision vectors on the SSD" enquanto mantém "the compressed vectors of all the data points in memory". A busca usa os vetores comprimidos para decidir quais vizinhanças ler do disco. Para limitar as idas e vindas ele usa o **BeamSearch**: busca as vizinhanças de um pequeno número W (digamos 4 ou 8) dos candidatos mais próximos de uma só vez, porque ler alguns setores aleatórios custa quase o mesmo que ler um. Um W grande demais (16 ou mais) desperdiça computação e banda de SSD. O paper declara a meta de engenharia do SSD: algumas dezenas de leituras aleatórias por consulta e menos de dez (de preferência cinco) idas e vindas.

**Construindo em escala.** Para indexar um bilhão de pontos sem mantê-los na memória, ele particiona os dados em k clusters (por exemplo 40) com k-means, atribui cada ponto a vários clusters próximos, constrói um grafo Vamana por cluster em memória e faz o merge dos grafos pela união das arestas. A sobreposição mantém o grafo resultante conectado.

**Resultados.** No SIFT1B com uma máquina de 16 núcleos: mais de 5.000 consultas por segundo, latência média abaixo de 3 ms, 1-recall@1 de 95%+; no regime de recall alto ele serve 5–10× mais pontos por nó que o HNSW e o NSG. São medições dos autores em um dataset e uma classe de máquina.

**O que o paper não nos dá.** Ele constrói índices estáticos; as atualizações são o assunto do paper de continuação abaixo.

### 3.4 Updates on a graph index: FreshDiskANN `[CONFIRMED]` (Singh et al., 2021)

O paper de continuação parte exatamente da lacuna acima: os índices de grafo existentes "support only static indices that cannot reflect real-time changes to the corpus", então a "current industry practice" é reconstruir periodicamente, "which can be prohibitively expensive". Ele também mostra que regras de atualização simples degradam a qualidade de grafos HNSW e NSG ao longo de um fluxo de inserts e deletes. Seu design:
- **FreshVamana**, um índice de grafo com regras de insert e delete que permanecem estáveis ao longo de fluxos longos de atualização. Os deletes são **lazy**: um ponto apagado vai para uma DeleteList sem alterar o grafo; durante a busca esses nós ainda são usados para navegação mas filtrados dos resultados. Depois que 1–10% do índice foi apagado, uma **delete consolidation** em lote repara as vizinhanças dos pontos que apontavam para nós apagados.
- **Formato do sistema:** um índice de longo prazo residente em SSD sobre a maior parte dos pontos mais um índice de curto prazo em memória para atualizações recentes; um **StreamingMerge** em background incorpora o índice de curto prazo ao de longo prazo, com custo proporcional ao conjunto de mudanças, não ao índice inteiro.
- **Resultados relatados** (execuções de uma semana num subconjunto de quase um bilhão de pontos do SIFT1B, 48 núcleos, 3,2 TB de SSD): menos de 128 GB de DRAM o tempo todo; 1.800 inserts e 1.800 deletes por segundo de forma estável (rajadas de até 40.000 inserts por segundo); latência de atualização abaixo de 1 ms mesmo durante um merge; 1.000 buscas por segundo com 5-recall@5 de 95%+ e latência média bem abaixo de 20 ms; um merge de uma mudança de 10% em cerca de 10% do tempo de uma reconstrução; e uma redução declarada de 5–10 vezes no custo de manter o frescor em comparação com os métodos existentes (o paper não enquadra isso apenas como comparação com a reconstrução).

Esta é a versão publicada do padrão de um pequeno índice fresco mais merge periódico usado na seção 4. Esses números são dos autores, em um dataset e uma máquina.

---

## 4. The platform around the index `[INDUSTRY PATTERN]`

```
app ─► embed query ─► coordinator ─► shard 1 … shard N (replicas) ─► top-K per shard ─► merge ─► results
                          └────────► fresh-writes index ─────────────┘
source ─► embed ─► fresh-writes index ─► periodic build ─► index segments in object storage ─► shards load
```

- **Sharding e fan-out:** divida os vetores entre shards; o coordenador consulta todos os shards (ou um subconjunto escolhido, se os dados forem particionados por tenant ou categoria) e faz o merge das listas top-K. O shard mais lento define a latência, então use réplicas e timeouts. O número do Taobao da seção 3.3 é um exemplo publicado desse formato.
- **Réplicas:** replique cada shard por disponibilidade e throughput; roteie as consultas para a réplica saudável menos carregada.
- **Filtragem:** aplique o filtro dentro da busca (conferindo os atributos de cada candidato enquanto o grafo é percorrido), depois dela (post-filter e over-fetch) ou particionando o índice pela chave do filtro. A documentação do pgvector é um exemplo concreto do trade-off: com índices aproximados, o filtro é aplicado depois que o índice é varrido, então se uma condição casa com 10% das linhas e a lista de candidatos do HNSW (`ef_search`) é o padrão de 40, em média só 4 linhas casam `[CONFIRMED]`. Ele oferece varreduras iterativas de índice (a partir da versão 0.8.0) que continuam varrendo até haver resultados suficientes, índices parciais para poucos valores de filtro e particionamento para muitos. Filtros fortes fazem o post-filtering desperdiçar resultados; ajuste e meça o recall sob filtros.
- **Frescor:** escreva novos vetores num pequeno índice em memória que é consultado junto com o principal, e incorpore-os ao índice principal em builds periódicos. Os deletes são tombstones aplicados na hora da consulta até a próxima reconstrução ou consolidação, como a DeleteList do FreshDiskANN.
- **Mudanças de modelo de embedding:** todo vetor muda, então construa um índice novo ao lado do antigo, valide o recall num conjunto rotulado, depois troque o tráfego (blue/green) e mantenha o antigo para rollback.
- **Busca híbrida:** combine com busca por palavras-chave para termos exatos; veja [23 RAG knowledge assistant](23-rag-knowledge-assistant.md) para saber por quê.
- **Monitoramento de qualidade:** mantenha um conjunto rotulado de consultas, calcule o recall do índice ANN contra a busca exata numa amostra e alerte quando cair.

---

## 5. Capacity reasoning (illustrative)

- **Bytes brutos dos vetores** = vetores × dimensões × bytes por número. Um bilhão de vetores de 128 dimensões a 1 byte (como o uint8 do SIFT1B) são 128 GB; com 768 dimensões em floats de 4 bytes são cerca de 3 TB.
- **Códigos comprimidos:** a 32 bytes por vetor (o tamanho de exemplo no paper do DiskANN) um bilhão de vetores ocupa cerca de 32 GB.
- **Overhead do grafo:** arestas por vetor × tamanho do id. Com 64 vizinhos de 4 bytes cada, 256 bytes por vetor além do próprio vetor; o número exato depende do índice e dos seus parâmetros.
- **Shards** = memória total necessária ÷ memória utilizável por máquina, depois multiplique pelas réplicas para disponibilidade.
- Esta é aritmética nossa, e as dimensões, a precisão e o grau são premissas.

---

## 6. Failure scenarios

- **Um shard está lento ou fora do ar.** O coordenador precisa escolher entre esperar, tentar outra réplica ou devolver resultados parciais. Um timeout com retry em réplica é o meio-termo usual `[INDUSTRY PATTERN]`.
- **O recall cai em silêncio.** A deriva dos dados, a compressão agressiva ou uma lista de busca pequena demais reduzem o recall sem erros; monitore contra a busca exata em amostras `[INDUSTRY PATTERN]`.
- **O filtro deixa os resultados vazios ou fracos.** Um filtro restritivo aplicado depois do retrieval deixa poucos resultados; faça over-fetch ou use travessia filtrada `[INDUSTRY PATTERN]`.
- **Pressão de memória.** Um índice que não cabe mais na RAM se degrada bruscamente, que é o que o design do DiskANN trata ao mover os vetores completos para o SSD `[CONFIRMED]` para esse design.
- **A reconstrução do índice falha.** Mantenha o índice anterior servindo e avance só após a validação `[INDUSTRY PATTERN]`.

---

## ⚠️ Reviewer notes

1. **Os números de recall não são comparáveis entre papers.** Eles usam datasets, hardware, k e definições de recall diferentes. Citamos cada um com sua definição.
2. **A comparação do DiskANN com o Faiss é de 2019.** O paper diz que o Faiss "supports searching only from RAM", citando um post de blog do Faiss da época; versões posteriores do Faiss podem ser diferentes, e não conferimos.
3. **O número de sharding do Taobao é de segunda mão:** o paper do DiskANN o relata citando outro paper, e não lemos o original.
4. **Deletes e atualizações:** os papers do HNSW e do DiskANN original não os cobrem; o FreshDiskANN (seção 3.4) cobre para o grafo Vamana, em um dataset. Se a mesma abordagem serve a outras famílias de índice não é mostrado pelas fontes que lemos.
5. **Not read:** documentação de produto de bancos vetoriais além do pgvector (Elasticsearch, Pinecone e outros), ScaNN, papers de locality-sensitive hashing, pesquisa sobre busca ANN filtrada.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não dos papers. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance** (latência numa meta de recall), **escalabilidade** (bilhões de vetores), **custo** (memória), **disponibilidade**, **frescor dos dados**.
- **Estilo (Ch 13):** **service-based** com um coordenador stateless sobre shards de índice stateful.
- **Quanta (Ch 7):** cada réplica de shard é um quantum com seu próprio estado em memória; o construtor do índice é separado e em batch.
- **Trade-off (First Law, Ch 1):** **recall vs latência vs memória.** Você não consegue maximizar os três; a família do índice e seus parâmetros escolhem um ponto.
- **Esboço de ADR (Ch 19):** *"Vamos usar um índice de grafo comprimido em shards apoiados em SSD, com um pequeno índice em memória para escritas novas. Aceitamos reconstruções periódicas e um segundo índice para pesquisar em troca de um custo de memória menor."*
- Em linguagem simples: um mapa de atalhos numa biblioteca muito grande, reconstruído de acordo com um cronograma.

---

## Interview questions to practice

1. Por que não podemos simplesmente comparar uma consulta com todos os vetores?
2. Como o HNSW funciona, e o que M e ef controlam?
3. O que a product quantization faz, e quanto custa?
4. Como você serviria um bilhão de vetores? Quando faz shard e quando usa SSD?
5. Como você suportaria filtros como "category = shoes and price < 50"?
6. Como você tornaria os itens novos pesquisáveis em segundos?
7. Você muda o modelo de embedding. O que acontece?
8. Como você mede se o índice é bom o bastante?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: contagem de vetores e dimensões, metas de latência e recall, filtros, frescor, mudanças de modelo.
2. Estimar: bytes brutos, bytes comprimidos, overhead do grafo, shards e réplicas, consultas por segundo.
3. API: upsert, delete, consulta com filtro e k.
4. Design: serviço de embedding, coordenador, shards com índice ANN, índice de escritas frescas, construtor, object storage.
5. Deep dive: escolha da família do índice e dos parâmetros; filtragem; frescor.
6. Falhas e escala: shard lento, deriva de recall, pressão de memória, reindexação.

**Se crescer 10×**
- A memória domina o custo: comprima os vetores, mova os vetores completos para o SSD, mantenha só os códigos comprimidos na RAM.
- A cauda de latência cresce com o número de shards: use menos shards maiores quando possível, hedged requests e particionamento por tenant ou categoria.
- O tempo de reconstrução cresce: construa por segmento e faça merge, como o DiskANN faz o merge dos grafos por cluster.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Como o HNSW funciona?</summary>

Uma pilha de grafos de proximidade: camadas superiores esparsas com pulos longos, uma camada inferior densa com todos os elementos. Uma busca entra pelo topo, move-se de forma gulosa para o vizinho mais próximo da consulta, desce uma camada quando não consegue melhorar e, na base, explora uma lista de candidatos de tamanho ef. M e ef maiores aumentam o recall e custam memória e tempo.

</details>

<details><summary>Como você suporta filtros?</summary>

Opções: conferir o predicado enquanto percorre, fazer post-filter com over-fetching, ou particionar pela chave do filtro. Filtros muito seletivos quebram o post-filtering, então meça o recall com filtros ligados, não só sem eles.

</details>

<details><summary>Você muda o modelo de embedding. O que acontece?</summary>

Todos os vetores ficam incompatíveis com os vetores de consulta do novo modelo, então você reembeda tudo e constrói um índice novo ao lado do antigo, compara o recall num conjunto rotulado, troca o tráfego e mantém o índice antigo até ter confiança.

</details>

## 📚 Further reading

- Os três papers listados em Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) para saber o que são embeddings.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [23 RAG knowledge assistant](23-rag-knowledge-assistant.md), [20 Web crawler and search](20-web-crawler-search.md), [03 Distributed key-value store](03-distributed-kv-store.md) para sharding e replicação.

## Sources and provenance

> **Kind:** reference design com partes reais. HNSW, Faiss e DiskANN são designs publicados. Como qualquer fornecedor de banco vetorial constrói o seu produto não é coberto aqui, então a plataforma da seção 4 é o design padrão `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (texto dos PDFs extraído localmente):** Malkov and Yashunin, [*Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs*](https://arxiv.org/pdf/1603.09320) (arXiv 1603.09320) · Douze et al., [*The Faiss library*](https://arxiv.org/pdf/2401.08281) (arXiv 2401.08281, v4 out 2025) · Subramanya et al., [*DiskANN: Fast Accurate Billion-point Nearest Neighbor Search on a Single Node*](https://papers.nips.cc/paper_files/paper/2019/file/09853c7fb1d3f8ee67a61b6bf4a7f8e6-Paper.pdf) (NeurIPS 2019) · Singh et al., [*FreshDiskANN: A Fast and Accurate Graph-Based ANN Index for Streaming Similarity Search*](https://arxiv.org/pdf/2105.09613) (2021) · [README](https://raw.githubusercontent.com/pgvector/pgvector/master/README.md) do pgvector (lido em 2026-10-27).
> **Dated material:** os papers do HNSW e do DiskANN são de 2016–2019; o Faiss e a área evoluíram desde então.
> **Not read:** documentação de outros bancos vetoriais, ScaNN, papers de ANN filtrada e benchmarks como o ANN-Benchmarks.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the HNSW paper: multi-layer proximity graphs, random maximum layer with exponentially decaying probability, logarithmic complexity scaling, skip list analogy, neighbour-selection heuristic, M range 5–48 and memory proportional to M, efConstruction guidance (recall near 1 during construction). No deletion procedure found.
- Verified in the Faiss paper: scope statement (not a service or database), trade-off axes, IVF and nprobe, metadata and filtered-search limits, index updates by id, degradation when the distribution changes.
- Verified in the DiskANN paper: abstract figures (64 GB RAM, SSD, over 5,000 QPS, under 3 ms, 95%+ 1-recall@1, 5–10× more points per node), the compression-based class at around 0.5 1-recall@1, the 100M-vector NSG footprint of about 75 GB (assuming degree 50), the Taobao sharding example as cited, PQ in memory with graph and full vectors on SSD, BeamSearch with W of 4 or 8, the SSD engineering target, k-means overlapping clusters merged by edge union.
- Verified in FreshDiskANN: the static-index problem statement, lazy deletion with a DeleteList and batch consolidation, long-term and short-term index design with StreamingMerge, the reported throughput, latency, DRAM and recall figures.
- Verified in the pgvector README: post-index filtering and the 10% / ef_search 40 / 4 rows example, iterative scans from 0.8.0, partial indexes and partitioning.
- Labelled industry pattern, not sourced: sharding and coordinator design, replicas, the combined filtering strategy list, re-indexing, monitoring, capacity arithmetic.
- Not claimed: behaviour of any named vector database other than the pgvector documentation points above.
