# 06 — File Sync (Dropbox)

*Um sistema real documentado. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** O Dropbox divide os arquivos em blocos de 4 MB identificados por SHA-256 e envia apenas os blocos que o servidor não tem. O conteúdo vive no Magic Pocket, um block store imutável feito em casa e separado do metadata store Edgestore. O motor de sync do cliente, o Nucleus, mantém três árvores (remota, local, synced) e planeja operações para fazê-las convergir, testado com simulação determinística.

**Números principais**
- Blocos de até 4 MB, SHA-256 `[CONFIRMED]`.
- Cells do Magic Pocket de cerca de 50 PB, cada bloco em pelo menos duas zonas `[CONFIRMED]`.
- Streaming sync: sync multi-cliente até 2× mais rápido `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Blocos endereçados por conteúdo | Pular blocos já armazenados, uploads retomáveis | Uma fronteira fixa se desloca se bytes são inseridos |
| Blocos separados dos metadados | Cargas diferentes escalam de forma independente | Dois sistemas para manter consistentes pela ordem do commit |
| Sync do cliente com três árvores | Diz de que lado houve mudança | Um cliente complexo, daí o teste por simulação |

**Erros comuns**
- Chamar isso de deduplicação entre usuários: os posts só descrevem 'need blocks'.
- Presumir que o Dropbox ainda roda no S3 para o conteúdo dos usuários.
- Tratar um timeout como falha e reenviar tudo, em vez de repetir o mesmo commit.


---

## 🧒 Non-technical explanation

O Dropbox é um **arquivo compartilhado que te acompanha por aí**. Você mantém uma cópia do arquivo em cada dispositivo, e um **funcionário noturno** garante que todas as cópias acabem idênticas.

O funcionário trabalha com esperteza:
- Cada arquivo é rasgado em **páginas de tamanho fixo** e cada página ganha uma **impressão digital**. Um arquivo é apenas uma lista de impressões digitais.
- Antes de você enviar qualquer coisa, o funcionário pergunta ao depósito "quais destas impressões digitais vocês **não** têm ainda?" e você envia só essas páginas. Renomeie um arquivo ou copie-o, e quase nada se move.
- O funcionário guarda **três anotações** — como a nuvem está, como o seu disco está e como os dois estavam **da última vez em que concordaram** — de modo que, quando duas cópias diferem, ele consegue dizer de que lado houve mudança de verdade.

---

## TL;DR for engineers

- **Blocos endereçados por conteúdo:** cada arquivo é dividido em blocos de até **4 MB**, cada um com hash **SHA-256**. O **blocklist** do arquivo (a lista de hashes) identifica o seu conteúdo `[CONFIRMED]`.
- **Protocolo de upload:** o cliente faz o commit de um blocklist. O servidor responde "need blocks" para os que faltam. O cliente envia só esses direto a um block server e faz o commit de novo `[CONFIRMED]`. Blocos existentes nunca são reenviados.
- **Content store = Magic Pocket:** um block store imutável de vários exabytes, feito em casa, com um sistema de **metadados** separado. Os blocos são endereçados por hash, agrupados em buckets de 1 GB e com **erasure coding** `[CONFIRMED]`.
- **Metadata store = Edgestore:** um store baseado em MySQL com sharding, com entities e associations, consistência forte por padrão e uma camada de cache para leitura intensa `[CONFIRMED]`.
- **Cliente = Nucleus:** um motor de sync em Rust com **três árvores** (Remote, Local, Synced) e um **planner** que produz operações para fazê-las convergir. Testado com simulação aleatória determinística `[CONFIRMED]`.
- O **streaming sync** deixa um cliente que baixa começar a buscar blocos de um arquivo antes de o uploader tê-lo comitado, reduzindo o tempo de sync multi-cliente `[CONFIRMED]`.

---

## 1. Requirements (design framing)

**Funcionais:** manter uma pasta idêntica em vários dispositivos · upload e download eficientes de arquivos grandes · compartilhamento · histórico de versões · edições offline que se mesclam na reconexão.

**Não funcionais:** **durabilidade acima de tudo** (a meta de design declarada pelo Dropbox: durabilidade anual acima de 99,9999999999% e disponibilidade acima de 99,99% `[CONFIRMED]`, "Scaling to exabytes and beyond") · baixa latência de sync · **eficiência de banda** · nunca perder nem sobrescrever em silêncio a edição de um usuário · correção sob edições concorrentes de vários dispositivos.

---

## 2. Blocks, blocklists and the upload protocol `[CONFIRMED]`

De *Streaming File Synchronization*:
- "Every file in Dropbox is partitioned into **4MB blocks**, with the final block potentially being smaller." Os blocos recebem hash **SHA-256**. Um arquivo é identificado de forma única pelo seu **blocklist**.
- Protocolo de upload antes do streaming sync: (1) o cliente tenta fazer o **commit** do blocklist. Se faltam blocos, a chamada devolve **"need blocks"** listando-os. (2) O cliente envia esses blocos **direto a um blockserver**. (3) O cliente **faz o commit de novo** e o arquivo é registrado.

O que isso compra (análise nossa, `[INDUSTRY PATTERN]`):
- **Dedup dentro de um store:** o post descreve o mecanismo "need blocks", mas não usa a palavra "deduplication", então a apresentamos como uma consequência, não como uma afirmação do Dropbox: blocos que já estão no store não precisam ser enviados de novo.
- **Retomável e paralelo:** os blocos são independentes, então um upload que falhou é retomado por bloco, e os blocos podem ir em paralelo.
- **Edições baratas:** mude uma região de um arquivo grande e só os blocos alterados diferem no blocklist. (O post não discute delta encoding, então trate isto como inferência a partir de blocos de tamanho fixo.)

### Streaming sync `[CONFIRMED]`

Antes dele, "the entire file must be uploaded to our servers and committed to our databases" antes que outros clientes pudessem vê-lo. O streaming sync guarda o blocklist de um arquivo ainda não comitado numa entrada de memcache (escrita num commit que falhou, lida pelo `list`), de modo que o cliente que baixa fica sabendo do arquivo cedo e faz prefetch dos blocos nos block servers; ele está quase pronto quando o commit dos metadados chega. O objetivo: o downloader deve "always be just one blockserver network call behind the uploading client". O Dropbox relata uma melhoria de "up to 2x" no sync multi-cliente, e um teste foi de 89 s para 64 s num arquivo de 100 MB. Aplica-se apenas a arquivos novos e grandes.

---

## 3. Magic Pocket: the content store `[CONFIRMED]`

| Conceito | O que os posts dizem |
|---|---|
| **Block** | Pedaço criptografado de um arquivo de até 4 MB. **Imutável** depois de escrito. Na maioria dos usos a chave é o seu hash SHA-256 |
| **Bucket** | Os blocos são agregados em "1GB logical storage containers called buckets" |
| **Volume** | Um ou mais buckets replicados num conjunto de nós físicos de storage (OSDs) |
| **Cell** | Um cluster lógico autocontido que armazena "around 50PB of raw data" com um único Master. Uma cell escala até "around a hundred petabytes" antes que o overhead do master pese |
| **Block Index** | Mapeia hash para cell, bucket e checksum. Um "giant sharded MySQL cluster" atrás de uma camada de serviço RPC |
| **Replication Table** | Também MySQL. Mapeia buckets para volumes e OSDs. Muito menor que o Block Index |
| **Zones** | Clusters de servidores no oeste, centro e leste dos EUA. **Todo bloco é armazenado em pelo menos duas zonas**, e um bloco é escrito numa zona remota "within one second of it being uploaded locally" |
| **Repair** | Começa "once an OSD has been offline for 15 minutes" |
| **Erasure coding** | "Erasure coding for nearly all data". Dados recentes são replicados primeiro, depois agregados e recebem erasure coding. Um serviço **Live Coder** pode escrever direto em volumes com erasure coding (não é ideal para tráfego sensível à latência). **O esquema e os parâmetros não são dados nos posts que lemos** |

**Histórico** (de "Scaling to exabytes and beyond", 2016-03-14): o Dropbox disse "We were an early adopter of Amazon S3", com o conteúdo dos arquivos armazenado na Amazon. Começou a armazenar e servir arquivos de usuários exclusivamente em casa em **2015-02-27**, e chegou a **mais de 90%** dos dados de usuários em casa em **2015-10-07**. Seu crescimento "from our initial double-digit-petabyte prototypes to a multi-exabyte behemoth" levou "around 6 months" (Inside the Magic Pocket). A maior parte do Magic Pocket foi construída por "less than half a dozen people".

**Por que separar blocos de metadados?** Os blocos são grandes, imutáveis e meio frios: uma carga diferente da dos metadados pequenos, quentes e fortemente consistentes. Essa separação é o motivo de o Block Index ser uma consulta *para dentro* do storage, e não parte do registro de metadados do arquivo `[INDUSTRY PATTERN]`.

---

## 4. Edgestore: the metadata store `[CONFIRMED]` ((Re)Introducing Edgestore)

- Os objetos são **Entities** ou **Associations** com atributos definidos pelo usuário. As associations descrevem relações entre entities. Os exemplos do post são usuários, times, pastas, mensagens de e-mail e tokens U2F, e ele não nomeia arquivos nem namespaces explicitamente.
- **Cores** stateless roteiam as requisições para o shard que é o master dos dados. As **Engines** os armazenam. Uma **camada de cache** (particionada e replicada) acelera a carga de leitura intensa, com invalidação de cache nas escritas para consistência forte.
- **Strong consistency por padrão**, eventual consistency sob demanda.
- Escala conforme declarada nesse post: "several trillion entries", "millions of queries per second", "5–9s of availability", em "thousands of machines across multiple data centers". São números mais antigos.
- Um conjunto posterior de posts do Dropbox (achado em busca, não lido por inteiro) descreve o Panda, uma camada key-value entre o Edgestore e o MySQL com sharding, para rebalanceamento e two-phase commit. Não usamos seus detalhes aqui.

---

## 5. The client: Nucleus `[CONFIRMED]`

### Why it was rewritten
O modelo de dados do motor antigo foi projetado para um mundo sem compartilhamento: "files lacked a stable identifier that would be preserved across moves". Correções incrementais não conseguiam mudar a fundação, e o locking de granularidade grossa abria mão do paralelismo em troca de um raciocínio mais fácil.

### The three trees (*Testing sync at Dropbox*)
| Árvore | Significado |
|---|---|
| **Remote Tree** | "The latest state of the user's Dropbox in the cloud" |
| **Local Tree** | "The last observed state of the user's Dropbox on disk" |
| **Synced Tree** | "The last known 'fully synced' state between the Remote Tree and Local Tree" |

O sync está completo quando as três coincidem. O **planner** recebe as três árvores e produz "a series of operations to incrementally converge the trees". Ter a Synced Tree como **ancestral comum** é o que permite saber se o lado remoto, o local ou ambos mudaram alguma coisa, que é a ideia clássica do three-way merge `[INDUSTRY PATTERN]`.

### Design and testing
- Escrito em **Rust**, para que o sistema de tipos codifique invariantes. A maior parte do código roda numa única **Control thread** que agenda futures, com rede, hashing e I/O de arquivos delegados a outras threads.
- A Control thread é **determinística** dadas entradas e agendamento fixos, então é submetida a fuzzing com simulação pseudoaleatória, e se uma verificação de correção do sync falha, "we can always reproduce the bug from the original seed". O Dropbox diz que roda "millions of scenarios every day".
- O **CanopyCheck** testa o planner (gera uma árvore, a perturba nas outras duas, roda o planner sem I/O real, verifica terminação, ausência de panics e correção, e depois reduz as falhas). O **Trinity** testa a concorrência do motor, como uma exclusão remota atropelando uma edição local concorrente.
- Garantias do protocolo (*Rewriting the heart…*): servidor e cliente concordam sobre o estado do filesystem remoto antes de considerar uma mutação. Pastas e arquivos compartilhados têm **identificadores globalmente únicos**. Os moves são **atômicos** independentemente do tamanho da subárvore.

---

## 6. End-to-end flows (interview framing)

**Editar um arquivo no dispositivo A e vê-lo no dispositivo B** `[INDUSTRY PATTERN]` exceto onde há tag:
1. O watcher de A vê a mudança e a Local Tree é atualizada `[CONFIRMED]` (modelo do Nucleus).
2. A calcula o hash do arquivo em blocos e faz o commit do blocklist `[CONFIRMED]`. O servidor devolve "need blocks" para os novos.
3. A envia os blocos que faltam a um blockserver e depois faz o commit `[CONFIRMED]`. Os metadados no Edgestore agora apontam para o novo blocklist.
4. B fica sabendo da mudança (um canal de notificação ou long-poll é o design padrão, mas o mecanismo específico não é coberto nos posts que lemos), atualiza sua Remote Tree, e o planner produz um plano de download `[CONFIRMED]` quanto à parte do planner.
5. B busca no block store os blocos que lhe faltam. O streaming sync pode deixá-lo começar antes do commit de A `[CONFIRMED]`.

**Conflitos:** quando o planner vê que os dois lados mudaram o mesmo caminho, a política do produto decide. A abordagem usual é manter ambos e renomear um como "conflicted copy". Os posts que lemos não detalham a política do Dropbox, então isto é `[INDUSTRY PATTERN]`.

---

## ⚠️ Reviewer notes

1. **"Dedup" é uma consequência, não um recurso citado.** O post do Streaming Sync descreve apenas "need blocks". O dedup entre usuários em particular, ou em que escopo os hashes são compartilhados, não foi declarado nos posts que lemos e não é afirmado aqui. (O armazenamento endereçado por conteúdo também tem implicações de segurança, então o escopo é uma questão de design real `[INDUSTRY PATTERN]`.)
2. **Não diga "o Dropbox roda no S3".** Rodava no começo, e migrou o conteúdo dos usuários para o Magic Pocket em 2015, segundo o próprio post do Dropbox.
3. **Blocos fixos de 4 MB não são content-defined chunking.** Inserir um byte no início de um arquivo desloca todas as fronteiras de bloco seguintes em esquemas de blocos fixos, então o hash de todos os blocos seguintes muda. Os posts que lemos descrevem blocos fixos. Não atribua ao Dropbox o chunking por rolling hash (como o usado pelo rsync ou por algumas ferramentas de backup). Isto é conhecimento geral `[INDUSTRY PATTERN]`.
4. **Vários números vêm de posts de 2015–2020** (os "5–9s" do Edgestore, o "multi-exabyte" do Magic Pocket, as cells de 50 PB). Descrevem aqueles anos.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não dos posts. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **durabilidade/recuperabilidade** (nunca perder dados), **integridade dos dados** (nunca sobrescrever em silêncio), **eficiência** (banda), **escalabilidade** e **testabilidade** (o teste por simulação do Dropbox é um investimento direto aqui).
- **Estilo (Ch 13/17):** uma divisão **service-based** em um plano de conteúdo (block servers, Magic Pocket), um plano de metadados (Edgestore) e um **rich client** com motor próprio. O cliente é tanto parte da arquitetura quanto qualquer servidor.
- **Quanta (Ch 7):** o content store e o metadata store são quanta separados, com necessidades diferentes: imutável e meio frio versus pequeno, quente e fortemente consistente. O Nucleus de cada cliente é o seu próprio quantum, que pode trabalhar offline.
- **Trade-off (First Law, Ch 1):** **complexidade do cliente vs simplicidade do servidor.** Empurrar o planejamento para o cliente reduz a carga do servidor e funciona offline, mas significa que a correção depende de código rodando em milhões de máquinas, e é por isso que o Dropbox investiu em simulação determinística.
- **Esboço de ADR (Ch 19):** *"Vamos armazenar blocos imutáveis, endereçados por hash, separadamente de metadados fortemente consistentes, e sincronizar com um planner de três árvores no cliente. Aceitamos um cliente complexo em troca de suporte offline e uploads baratos."*
- Em linguagem simples: as páginas e as fichas ficam em salas diferentes, e o funcionário noturno de cada escritório decide o que carregar entre elas.

---

## Interview questions to practice

1. Por que dividir um arquivo em blocos de tamanho fixo? O que dá errado quando alguém insere um byte no início de um arquivo grande? Como o content-defined chunking ajudaria?
2. Descreva o "need blocks". Por que o commit final dos metadados é separado do upload dos blocos?
3. Dois dispositivos editam o mesmo arquivo offline. O que a synced tree te diz, e o que o sistema deve fazer?
4. Por que manter os metadados dos blocos (hash → local) separados dos metadados dos arquivos?
5. Como você notificaria outros dispositivos de uma mudança sem polling?
6. Como você testaria um motor de sync cujos bugs só aparecem sob interleavings raros?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: tamanhos de arquivo, compartilhamento, edições offline, conflitos.
2. Estimar: arquivos, edições por dia, banda.
3. API: commit do blocklist, upload dos blocos, listar mudanças.
4. Design: block servers, metadata store, notificação, motor do cliente.
5. Deep dive: blocklists, três árvores, conflitos.
6. Falhas e escala: uploads interrompidos, edições concorrentes, fan-out de notificações.

**Se crescer 10×**
- Os metadados viram o gargalo: faça sharding e cache.
- Arquivos grandes: faça stream dos blocos para outros dispositivos antes do commit.
- Eficiência de storage: aplique erasure coding nos blocos frios.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Por que blocos de tamanho fixo, e o que dá errado quando um byte é inserido na frente?</summary>

Blocos fixos são simples e retomáveis, mas inserir um byte desloca todas as fronteiras seguintes, então o hash de todos os blocos seguintes muda. O content-defined chunking evita isso.

</details>

<details><summary>Por que o commit final dos metadados é separado do upload dos blocos?</summary>

Os blocos podem chegar em qualquer ordem e ser repetidos. O commit torna a nova versão visível de forma atômica, só quando todos os seus blocos estão presentes.

</details>

<details><summary>Dois dispositivos editam offline. O que a synced tree te diz?</summary>

Ela é o último estado acordado, então compará-la com cada lado mostra quem mudou o quê. Se os dois mudaram o mesmo caminho, você precisa de uma política de conflito, como manter ambos.

</details>

## 📚 Further reading

- Os posts do Dropbox listados no topo. Também [Alki, cold metadata](https://dropbox.tech/infrastructure/alki--or-how-we-learned-to-stop-worrying-and-love-cold-metadata) e [Cross-shard transactions at 10M requests per second](https://dropbox.tech/infrastructure/cross-shard-transactions-at-10-million-requests-per-second) (aparecem em buscas, não foram lidos aqui).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (contexto secundário sobre caching, replicação e consistência).
- Relacionado neste repositório: [05 Object storage](05-object-storage-s3.md) para erasure coding, e [`neokim-post/11` Google Docs](https://github.com/allmonty/study/blob/main/architecture/neokim-post/11-how-google-docs-works.md) para merge em tempo real.

## Sources and provenance

> **Kind:** real-system, parcialmente público. O blog de engenharia do Dropbox documenta a camada de block storage (Magic Pocket), o protocolo de upload por blocos/blocklists, o motor de sync Nucleus e o metadata store Edgestore. Ele **não** publica o protocolo completo de notificação de mudanças entre cliente e servidor, então essa parte é um esboço de design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (all Dropbox Tech Blog):** [Inside the Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket) · [Scaling to exabytes and beyond](https://dropbox.tech/infrastructure/magic-pocket-infrastructure) (2016-03-14) · [Improving storage efficiency in Magic Pocket](https://dropbox.tech/infrastructure/improving-storage-efficiency-in-magic-pocket-our-immutable-blob-store) · [Streaming File Synchronization](https://dropbox.tech/infrastructure/streaming-file-synchronization) · [Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine) · [Testing sync at Dropbox](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine) · [(Re)Introducing Edgestore](https://dropbox.tech/infrastructure/reintroducing-edgestore).
> **Dated material:** os posts do blog abrangem vários anos. Os números de escala valem para a data de cada post, não são atuais.
> **Tags:** `[CONFIRMED]` afirmado por um post do Dropbox · `[INDUSTRY PATTERN]` prática padrão, não declarada para o Dropbox · `[SPECULATIVE]` plausível.

---
## ✅ Verification log

*Fact-check, 2026-10-27, each post fetched and read. Quotes in this file match the fetched text.* Claims we could not confirm were dropped or downgraded rather than kept, as listed below.
- Verified: Magic Pocket "multi-exabyte", growth in "around 6 months", 4 MB encrypted immutable blocks keyed by SHA-256, 1 GB buckets, volumes, ~50 PB cells with a single Master (~100 PB limit), OSD capacity, replicate-then-erasure-code, Block Index and Replication Table in MySQL, two-zone minimum with remote write "within one second", 15-minute repair trigger, "less than half a dozen people".
- Verified: 2015-02-27 first in-house cutover, 2015-10-07 90% milestone, "early adopter of Amazon S3", durability/availability design targets (2016-03-14 post).
- Verified: 4 MB blocks, SHA-256, blocklist, "need blocks" protocol, streaming-sync behaviour, "up to 2x", the 89 s → 64 s test.
- Verified: Nucleus reasons for the rewrite, the Rust/Control-thread design, deterministic simulation with seeds, "millions of scenarios every day", the three trees with their quoted definitions, the planner, CanopyCheck's steps, Trinity's purpose, protocol guarantees on unique IDs and atomic moves.
- Verified: Edgestore entities/associations, Cores/Engines/caching, strong consistency by default, "several trillion entries", "millions of queries per second", "5–9s".
- Removed: the "S3 migration" and "LRC" and "2x→1.5x" ideas we had expected to find. The posts we read do not state them, so we do not either. Erasure-coding parameters are marked as not public.
- Removed: any detail of Dropbox's public HTTP API (cursors, long-poll). Our fetch of the API docs returned only navigation, so nothing from it is used.
- Not read in full: Panda, Alki, cross-shard transactions (seen only in search snippets), so used only as pointers.
- Scoped: "dedup", conflict handling, device notification and the end-to-end flow are labelled `[INDUSTRY PATTERN]` because no Dropbox post we read states them.
- Corrected (independent review, 2026-10-27): streaming sync keeps the blocklist of an uncommitted file in memcache, not the block data; the downloader prefetches blocks from the block servers.
