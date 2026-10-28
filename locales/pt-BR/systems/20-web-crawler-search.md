# 20 — Web Crawler + Search

*Um sistema real documentado. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um crawler é um URL frontier, fetchers assíncronos e dois testes de dedup (URL já vista, conteúdo já visto), limitados por politeness e pelo robots.txt. Um mecanismo de busca transforma as páginas armazenadas num inverted index, ordenado a partir de hits por documento, e ranqueia com correspondência de texto mais sinais de links como o PageRank. Os números das fontes são de 1998 e 2001.

**Números principais**
- O Mercator espera 10× o tempo de download antes de revisitar um host `[CONFIRMED]`.
- Google de 1998: ~300 conexões por crawler, 100+ páginas/s no pico `[CONFIRMED]`.
- RFC 9309: 5xx no robots.txt significa presumir disallow completo; cache de no máximo 24 horas `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Filas de politeness por host | Nunca sobrecarregar um site | Menos ordenação global das URLs |
| Conjunto de fingerprints para URL-seen | Memória limitada | Uma probabilidade minúscula de colisão |
| Frontier apoiado em disco | Escala além da memória | Agendamento mais lento |

**Erros comuns**
- Dizer que 4xx no robots.txt significa disallow: significa que o crawler PODE acessar qualquer coisa.
- Citar `Crawl-delay` da RFC 9309: ele não está nela.
- Apresentar um Bloom filter como o que o Mercator usava.


---

## 🧒 Non-technical explanation

Um web crawler é um **assistente de bibliotecário com uma lista de endereços para visitar**. Ele visita um endereço, copia a página, anota todo endereço mencionado nela e acrescenta os **novos** à lista. Ele precisa:
- **Não visitar o mesmo lugar duas vezes** (um enorme problema de memória quando a lista tem bilhões de entradas),
- **Não incomodar os vizinhos** (nunca martelar um único site, e sempre conferir a placa de "proibida a entrada", o `robots.txt`),
- **Continuar por semanas** sem perder a lista.

O mecanismo de busca é o **índice remissivo no fim de um livro**, mas para a web inteira: para cada palavra ele guarda uma lista das páginas que a contêm, de modo que você nunca lê todas as páginas para responder a uma pergunta.

---

## TL;DR for engineers

- **Crawler = frontier + fetchers + dedup.** Um **URL frontier** entrega URLs. Muitos fetchers as baixam de forma assíncrona. Os links extraídos passam por um teste de **"URL seen?"** e um de **"content seen?"** antes de serem enfileirados `[CONFIRMED]` (Mercator).
- **A politeness é uma restrição de design de primeira classe.** O Mercator espera **10× o tempo que um download levou** antes de contatar o mesmo host de novo, e o padrão manda obedecer o `robots.txt` `[CONFIRMED]`.
- **Regras do robots.txt (RFC 9309):** busque antes do conteúdo, mantenha em cache no máximo **24 horas** (salvo se inalcançável), 4xx significa "indisponível" então o crawler **PODE acessar qualquer coisa**, 5xx ou erros de rede significam **presumir disallow completo**, vence a correspondência mais específica, faça parsing de pelo menos **500 KiB**. Ele não é "a form of access authorization" `[CONFIRMED]`.
- **Search index = inverted index:** o indexer transforma as páginas buscadas em **hits** por palavra, distribui-os em **barrels**, e um sorter os inverte para que cada palavra aponte para seus documentos. O **PageRank** do grafo de links alimenta o ranking `[CONFIRMED]` (Brin & Page).
- **O frescor do índice é um trade-off:** o Elasticsearch faz refresh para que novos documentos sejam pesquisáveis "within 1 second" (quase tempo real), não instantaneamente `[CONFIRMED]`.

---

## 1. Requirements (design framing)

**Funcionais (crawler):** começar de URLs semente · buscar HTML (e outros tipos) · extrair links · evitar duplicatas · respeitar o `robots.txt` e os rate limits · rebuscar para se manter atualizado · armazenar as páginas para indexação.

**Funcionais (busca):** construir um índice a partir das páginas · responder a consultas por palavras-chave com resultados ranqueados em milissegundos · suportar filtros e snippets.

**Não funcionais:** **escala** (bilhões de URLs) · **politeness** · **robustez** (a web é hostil: spider traps, páginas enormes, servidores lentos) · **frescor** vs custo · **extensibilidade** (novos tipos de conteúdo) · memória limitada.

**Abordagem de estimativa** `[SPECULATIVE]` (ilustrativa): rastrear 1 bilhão de páginas em 30 dias dá 1e9 / (30 × 86.400) ≈ 386 páginas por segundo. Com média de 100 KB por página, isso são ≈ 39 MB/s ≈ 3,3 TB/dia de HTML bruto, antes da compressão. Declare suas próprias premissas numa entrevista.

---

## 2. Crawler architecture

### Mercator's design `[CONFIRMED]` (Najork & Heydon, 2001)

O loop de crawl (do relatório): "select a URL from the set of URLs to download, determine the IP address of its host name, download the corresponding document, and extract any links contained in it. For each of the extracted links, ensure that it is an absolute URL (derelativizing it if necessary), and add it to the list of URLs to download, provided it has not been encountered before."

**Componentes** (Figura 1 do relatório): **módulos de protocolo** (HTTP, FTP, Gopher), **módulos de processamento** (extrator de links, estatísticas de GIF, contador de tags), um **resolvedor de DNS**, um **filtro de URLs**, o **URL frontier**, um teste de **"content seen?"** com fingerprints de documentos armazenados, um **Duplicate URL Eliminator (DUE)** e uma abstração de **re-readable input stream (RIS)** que permite a vários módulos lerem os mesmos bytes baixados.

Características que os autores listam: **distribuído** (simétrico entre as máquinas), **escalável** (memória principal limitada independentemente do tamanho da web, com a maior parte dos dados em disco), **alto desempenho**, **polite**, **contínuo** (rebusca com um mecanismo de prioridade), **extensível**.

| Componente | Como o Mercator faz |
|---|---|
| **Teste de URL-seen (DUE)** | Uma implementação mantém uma hash table em memória de checksums de 8 bytes das URLs (não das URLs), calculados com o **algoritmo de fingerprinting de Rabin**, que "gives exponentially small probabilistic bounds on the likelihood of a collision". Os 3 bytes de alta ordem indexam a espinha da tabela |
| **Teste de content-seen** | Depois que um documento é escrito no RIS, um teste verifica se um documento **com o mesmo conteúdo mas outra URL** já foi visto. Se sim, ele é descartado |
| **robots.txt** | O módulo HTTP mantém um cache de tamanho fixo das regras de robots por host: por padrão **2^18 entradas com descarte LRU** |
| **Politeness** | Nunca baixar várias páginas do mesmo servidor ao mesmo tempo. O melhor frontier usa filas por host e espera "**10 times as long as it took us to download a URL from a host before contacting that host again**", valores que "keep all threads busy and ... the rate of complaints to a bare minimum" |
| **Frontier em escala** | "The URL frontier soon outgrows the available memory of even the largest machines", então a maior parte das URLs vive em disco, e a melhor implementação é um frontier "polite, dynamic, prioritizing": filas FIFO por nível de prioridade alimentando filas FIFO de back-end (muito mais que as threads de worker) com uma fila de prioridade (ex.: um heap) decidindo quando cada host fica elegível de novo |
| **Throughput** | Um crawl em **quatro servidores Compaq DS20E Alpha de 666 MHz** que "saturated our 160 Mbit/sec Internet connection" baixou **cerca de 50 milhões de documentos por dia durante 17 dias** |

### Google's 1998 crawler `[CONFIRMED]` (Brin & Page)
- "Web crawling (downloading of web pages) is done by several distributed crawlers." Um **URLserver** envia listas de URLs aos crawlers, que enviam as páginas buscadas a um **storeserver** que as comprime num **repository**. Cada página recebe um **docID** quando sua URL é extraída de uma página.
- "A single URLserver serves lists of URLs to a number of crawlers (we typically ran about 3)." Cada crawler "keeps roughly **300 connections** open at once", e no pico o sistema "can crawl over **100 web pages per second** using four crawlers" (≈600 KB/s). Ambos foram escritos em **Python** na versão do paper.
- **O DNS é "a major performance stress"**, então cada crawler mantém seu **próprio cache de DNS**. O crawler usa **I/O assíncrono** com várias filas para mover as buscas entre estados (resolver DNS, conectar, enviar requisição, receber resposta).
- Realidade operacional: o crawling "is the most fragile application since it involves interacting with hundreds of thousands of web servers and various name servers which are all beyond the control of the system". Discos encheram, name servers caíram, e pessoas reclamaram do crawler ou não conheciam o `robots.txt`. Levou "roughly 9 days to download the 26 million pages (including errors)", e depois que rodou sem problemas teve média de "just over 4 million pages per day or 48.5 pages per second".

### robots.txt, per RFC 9309 `[CONFIRMED]`
- **Busque-o antes de rastrear o conteúdo** de um site. Ele vale por origem.
- **Indisponível** (HTTP 4xx): o crawler "MAY access any resources on the server".
- **Inalcançável** (HTTP 5xx ou erros de rede): "the crawler MUST assume complete disallow". (A RFC continua com o que fazer se isso durar muito tempo. Não lemos essa parte.)
- **Redirecionamentos:** os crawlers "SHOULD follow at least five consecutive redirects, even across authorities". Se o robots.txt for alcançado em até cinco, ele DEVE ser buscado, analisado e aplicado à autoridade inicial. Depois de mais de cinco, os crawlers PODEM presumir que ele está indisponível.
- **Correspondência:** "The most specific match found MUST be used", significando a correspondência com mais octetos. Allow vence disallow quando são equivalentes. Se nada corresponde, a URI é permitida.
- **Cache:** os crawlers PODEM guardar em cache, NÃO DEVERIAM usar uma cópia em cache por mais de **24 horas** salvo se estiver inalcançável. O **limite de parsing** deve ser de pelo menos **500 KiB**.
- **Nota de segurança:** "not a form of access authorization", e listar caminhos no robots.txt os torna descobríveis.

---

## 3. Indexing and search

### Google 1998: from pages to an inverted index `[CONFIRMED]`
1. O **indexer** lê o repository, descomprime os documentos e faz parsing deles, registrando cada palavra com sua posição, uma aproximação do tamanho da fonte e capitalização (um **hit**).
2. Ele distribui os hits em um conjunto de **barrels**, "creating a partially sorted forward index" indexado por docID. Também extrai **links** e texto âncora, transforma URLs relativas em docIDs e escreve o texto âncora no índice associado ao docID para o qual aponta. Gera um **links database** (pares de docIDs) usado para calcular o **PageRank**.
3. O **sorter** pega os barrels (ordenados por docID) e os reordena **por wordID** para gerar o **inverted index**, no próprio lugar, de modo que pouco espaço temporário é necessário. Um programa, o **DumpLexicon**, combina a lista do sorter com o lexicon para produzir um novo lexicon para o searcher.
4. O **searcher** roda como um web server e usa o lexicon, o inverted index e os PageRanks para responder às consultas.
- O **PageRank** é "a probability distribution over web pages" (os ranks somam um), calculado por um algoritmo iterativo simples sobre o grafo de links, com um damping factor. O paper diz "a PageRank for 26 million web pages can be computed in a few hours on a medium size workstation".
- **Escala em 1998:** 24 milhões de páginas no índice de demonstração. O indexer rodava a aproximadamente 54 páginas por segundo, e a ordenação em quatro máquinas levava cerca de 24 horas.

### A modern search tier `[INDUSTRY PATTERN]` plus one documented fact
- **Faça shard do índice** por documento (cada shard guarda um inverted index para a sua fatia de documentos) e faça **fan out** de cada consulta para todos os shards, depois o merge do top-K. Replique os shards por disponibilidade e throughput.
- **Segmentos:** a documentação do Elasticsearch diz "a segment is similar to an inverted index" e que os novos documentos são pesquisáveis "in near real-time -- within 1 second", porque um **refresh** "makes all operations performed on an index since the last refresh available for search". Então o frescor da busca tem um lag embutido, um trade-off que você pode ajustar `[CONFIRMED]`. (A página que lemos diz que o Elasticsearch faz refresh a cada segundo apenas para índices pesquisados nos últimos 30 segundos. Ela não cobria imutabilidade de segmentos nem merging, então não os declaramos.)
- O **ranking** é mais que correspondência de texto: autoridade baseada em links (estilo PageRank), texto âncora, frescor e sinais aprendidos. Brin e Page já combinavam hits de texto com PageRank e texto âncora `[CONFIRMED]`.
- **Caminho da consulta:** parse → consultar a posting list de cada termo → interseção/união → pontuar → top-K → buscar snippets. Guarde consultas populares em cache.

---

## 4. Putting it together `[INDUSTRY PATTERN]` unless tagged

```
seeds ─► URL frontier (priority + per-host queues, on disk) ─► fetchers (async, DNS cache)
              ▲                                                   │ robots.txt cache (≤24 h)
              │  URL-seen? (8-byte fingerprints)                   ▼
        link extractor ◄── content-seen? (doc fingerprints) ◄── downloaded page
                                      │
                                      ▼
                         repository (compressed pages) ─► indexer ─► barrels ─► sorter ─► inverted index shards
                                                                  └► link graph ─► PageRank ───────────────────┘
Query ─► front end ─► fan-out to shards ─► merge + rank ─► results
```

- **Particione o frontier por host** para que um worker seja dono do estado de politeness de cada host, e para que as regras de robots e os rate limits por host fiquem locais. O hash do host seleciona o worker.
- **Spider traps** (calendários infinitos, IDs de sessão em URLs) exigem limites de profundidade, tamanho de URL e contagem de páginas por host, além de normalização de URLs `[INDUSTRY PATTERN]`.
- **Política de recrawl:** priorize por taxa de mudança e importância. Rebusque com requisições condicionais (`If-Modified-Since`, `ETag`) para economizar banda `[INDUSTRY PATTERN]`.
- **Deduplique quase-duplicatas** (não apenas cópias exatas) com hashing de similaridade. O teste de content-seen do Mercator encontra conteúdo *idêntico* `[CONFIRMED]`, e a detecção de quase-duplicatas é uma técnica separada.
- **Faça o crawl como um pipeline de filas** para que um estágio lento (DNS, uma página enorme) não trave o resto, de acordo com a observação do Google de que o crawler usa filas para mover as buscas de páginas entre estados `[CONFIRMED]`.

---

## ⚠️ Reviewer notes

1. **Os números são de 1998 e 2001.** As 24 milhões de páginas de Brin & Page e os 50 milhões de documentos por dia do Mercator são históricos. Não os apresente como atuais. São úteis para o *formato* do problema e para as proporções (DNS, politeness, frontier em disco).
2. **Os Bloom filters não estão nas fontes que lemos.** Muitas respostas de entrevista usam um Bloom filter para "URL seen?". O Mercator usava uma **hash table de fingerprints de 8 bytes** e um conjunto apoiado em disco. Um Bloom filter é uma escolha de design válida (economiza memória, ao custo de falsos positivos fazerem algumas páginas novas serem puladas) `[INDUSTRY PATTERN]`, mas não é o que o paper citado descreve.
3. **Um 4xx no robots.txt significa "pode ir", e um 5xx significa "pare".** As pessoas costumam inverter isso. A RFC 9309 diz que um crawler PODE acessar qualquer coisa quando o robots.txt está indisponível (4xx), e DEVE presumir disallow completo quando ele está inalcançável (5xx ou erro de rede).
4. **`Crawl-delay` não está na RFC 9309.** Nossa busca não encontrou menção a ele, então não cite a RFC para isso. Atrasos de politeness são política do crawler.
5. **O robots.txt não é segurança.** Ele pede aos crawlers que se comportem, e não é controle de acesso.
6. **Não conseguimos verificar nenhum internals atual de mecanismos de busca.** A imutabilidade de segmentos, a política de merge e o translog não estavam na página da Elastic que lemos, então os omitimos.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **escalabilidade**, **performance** (throughput de busca, latência de consulta), **tolerância a falhas** (a web é pouco confiável), **politeness/ética** (um requisito não funcional incomum), **extensibilidade**, **frescor**.
- **Estilo (Ch 11, 14):** o crawler é uma **pipeline architecture** (fetch → parse → filter → store) sobre filas, e o sistema inteiro é **event-driven** com um backend de indexação em batch e uma camada de serving online.
- **Quanta (Ch 7):** crawl, construção do índice e serving de consultas são três quanta separados com características diferentes: de longa duração e tolerante a falhas, orientado a batch e crítico em latência, respectivamente. O serving de consultas precisa continuar no ar enquanto a indexação atrasa.
- **Trade-off (First Law, Ch 1):** **frescor vs custo e politeness.** Rebuscar com mais frequência dá resultados mais novos e mais carga nos servidores dos outros.
- **Esboço de ADR (Ch 19):** *"Vamos particionar o URL frontier por host e impor atrasos por host no worker dono. Aceitamos menos ordenação global das URLs em troca de uma politeness simples e local."*
- Em linguagem simples: dê a cada assistente alguns bairros e deixe que ele mantenha as anotações sobre com quem tomar cuidado.

---

## Interview questions to practice

1. Projete um crawler para 1 bilhão de páginas em um mês. Onde estão os gargalos (DNS, disco, politeness)?
2. Como evitar buscar a mesma URL duas vezes nessa escala, e quanto isso custa? Compare um hash set de fingerprints e um Bloom filter.
3. Um site devolve `503` para `/robots.txt`. O que você faz? E com `404`?
4. Como manter a politeness enquanto mantém milhares de threads ocupadas?
5. Como detectar páginas duplicadas com URLs diferentes? E quase-duplicatas?
6. Esboce o inverted index e o caminho da consulta. Como fazer o shard, e o que acontece com uma consulta que abrange todos os shards?
7. Quão fresco o índice deve ser, e quanto custa fazer refresh com mais frequência?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: escala, frescor, tipos de conteúdo, politeness.
2. Estimar: páginas/s e storage.
3. API: sementes na entrada, resultados ranqueados na saída.
4. Design: frontier, fetchers, dedup, repository, indexer, shards.
5. Deep dive: politeness, robots, inverted index, PageRank.
6. Falhas e escala: spider traps, custo de DNS, shard fan-out.

**Se crescer 10×**
- Tamanho do frontier: particione por host e mantenha em disco.
- Tamanho do índice: shard por documento e replicação.
- Frescor: priorize os recrawls pela taxa de mudança.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>1 bilhão de páginas em um mês: gargalos?</summary>

Cerca de 386 páginas/s: consultas de DNS, limites de politeness e o estado das URLs apoiado em disco dominam, não a CPU.

</details>

<details><summary>Como evitar buscar a mesma URL duas vezes?</summary>

Verifique um conjunto de fingerprints antes de enfileirar. Um Bloom filter economiza memória mas admite falsos positivos que pulam páginas novas.

</details>

<details><summary>Um site devolve 503 para o robots.txt. O que você faz?</summary>

Trate como inalcançável e presuma disallow completo, segundo a RFC 9309. Um 404 significa indisponível, o que permite o crawling.

</details>

## 📚 Further reading

- As quatro fontes listadas no topo. A versão web original de 1998 está em infolab.stanford.edu/~backrub/google.html (inalcançável da nossa rede, então lemos uma cópia do Internet Archive).
- [System Design Primer: Design a web crawler](https://github.com/donnemartin/system-design-primer) (secundária; enquadramento de entrevista).
- Relacionado neste repositório: [11 News feed](11-news-feed.md) (caches e fan-out), [03 Distributed KV store](03-distributed-kv-store.md) (particionamento), [02 Rate limiter](02-rate-limiter.md) (a politeness por host é um rate limit), [01 URL shortener](01-url-shortener.md) (Bloom filters).

## Sources and provenance

> **Kind:** real-system para as *ideias de design*, com evidências dos anos 1990 e início dos 2000. As duas descrições públicas fundamentais são o paper original do Google (Brin & Page, 1998) e o relatório do crawler Mercator (Najork & Heydon, 2001). Nenhum dos dois descreve o Google ou o Bing de hoje. O comportamento do robots.txt vem do padrão atual da IETF (RFC 9309). As especificidades do índice de busca de um mecanismo moderno vêm da documentação do Elasticsearch (só uma pequena parte era legível). Então esta nota explica *como um crawler e um índice de busca se encaixam*, com números datados, e não afirma como funciona qualquer mecanismo de busca atual.
> **Sources read on 2026-10-27:** Brin & Page, [*The Anatomy of a Large-Scale Hypertextual Web Search Engine*](https://snap.stanford.edu/class/cs224w-readings/Brin98Anatomy.pdf) (WWW7, 1998; lido a partir de uma cópia do Internet Archive da versão web, mais o PDF do paper extraído localmente) · Najork & Heydon, [*High-Performance Web Crawling*](https://www.cs.cornell.edu/courses/cs685/2002fa/mercator.pdf) (Compaq SRC Research Report 173, 2001-09-26; PDF extraído localmente) · IETF [RFC 9309: Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309) (texto) · Elastic docs: [Near real-time search](https://www.elastic.co/docs/manage-data/data-store/near-real-time-search).
> **Not read:** a documentação atual do Google/Bing, a documentação de formato de arquivo do Lucene, o Common Crawl, o Scrapy, ou qualquer orientação de crawl budget. Não fazemos afirmações sobre esses.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária lida agora · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível, ou uma estimativa ilustrativa.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* Both papers were extracted or read from local copies and grepped. RFC 9309 was downloaded and read as text.
- Verified in Brin & Page: URLserver, storeserver, repository and docID; ~3 crawlers (four at peak), ~300 connections each, 100+ pages per second at peak (≈600 KB/s); DNS as a major stress with per-crawler caches; asynchronous I/O and queues; Python implementation; the fragility paragraph; 9 days for 26 million pages and then 4 million+ pages per day (48.5 per second); indexer at ~54 pages per second; sorting ~24 hours on four machines; hits, barrels, forward index, links database, sorter, DumpLexicon, searcher; PageRank definition and "26 million pages in a few hours".
- Verified in the Mercator report: the crawl loop, component list and Figure 1, the six characteristics, the 8-byte Rabin-fingerprint URL set, content-seen test, robots cache of 2^18 entries with LRU, the 10× politeness delay, disk-based frontier and the four-Alpha-server crawl at about 50 million documents per day over 17 days.
- Verified in RFC 9309: robots.txt before crawling, "unavailable" (4xx) allows access, "unreachable" (5xx or network) means complete disallow, redirect rule (SHOULD follow at least five, MAY treat it as unavailable after more), most-specific-match and allow-wins-ties, 24-hour cache guidance, 500 KiB minimum parse limit, "not a form of access authorization". We found no mention of `Crawl-delay`.
- Verified in Elastic's docs: near real-time "within 1 second", refresh semantics, the 30-second search-activity condition, "a segment is similar to an inverted index".
- Not covered by the sources we read, so not stated: segment immutability and merging, the translog, BM25 as a default, any claim about how current search engines rank or crawl.
- Labelled industry pattern: partitioning by host, spider-trap caps, recrawl policy, near-duplicate detection, Bloom-filter alternative, the modern sharded query path, and the estimation arithmetic (checked by hand: 1e9/2.592e6 ≈ 386/s; 386 × 100 KB ≈ 38.6 MB/s ≈ 3.3 TB/day).
- Method note: the Brin & Page web version and PDF were both read. Mercator is the 2001 SRC report, not the 1999 Mercator paper, and dates and figures are from that report.
- Quote audit (2026-10-27): the PageRank sentence is now quoted in full ("a PageRank for 26 million web pages can be computed in a few hours on a medium size workstation") instead of an elided version.
