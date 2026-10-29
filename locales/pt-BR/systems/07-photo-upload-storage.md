# 07 — Photo Upload & Storage

*Um sistema real documentado. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Armazenar bilhões de fotos é um problema de metadados tanto quanto de dados. O Haystack do Facebook empacotava muitas fotos em arquivos enormes com um índice em memória, de modo que uma leitura custava cerca de um seek de disco, e o f4 depois moveu as fotos que esfriavam para um storage Reed-Solomon (10,4), reduzindo o fator de replicação efetivo de 3,6 para 2,1. Os uploads modernos vão direto para o blob storage com uma pre-signed URL de curta duração.

**Números principais**
- Haystack: cerca de 10 bytes de memória por foto contra 536 bytes de um inode xfs `[CONFIRMED]`.
- f4: replicação efetiva 3,6 → 2,8 → 2,1 `[CONFIRMED]`.
- O Facebook armazenava mais de 400 bilhões de fotos em fevereiro de 2014 `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Muitas fotos por arquivo grande | Mantém todos os metadados de arquivo em memória | Append-only, então os deletes exigem compaction |
| Camadas hot/warm por idade | Fotos warm podem usar storage mais barato | Uma camada de router e maquinário de migração |
| Upload direto para o blob | Os servidores de aplicação ficam fora do caminho dos dados | Pre-signed URLs são bearer tokens |

**Erros comuns**
- Apresentar o Haystack como a forma como o Instagram armazena fotos.
- Propor 'S3 mais CDN' sem dizer por que as pressões de metadados e de replicação se aplicam ou não.
- Usar pre-signed URLs de upload de longa duração ou fáceis de adivinhar.


---

## 🧒 Non-technical explanation

Um serviço de fotos é como um **laboratório fotográfico enorme com uma vitrine de exibição**.

- Você entrega sua foto ao laboratório por uma **porta lateral** (um passe de uso único permite levá-la direto ao arquivo sem incomodar a recepção).
- O laboratório faz **vários tamanhos de cópia**: miniatura, média, grande.
- Uma **parede de exibição na rua** (a CDN) mostra as fotos famosas. O **arquivo** nos fundos guarda todo o resto.
- O truque que fez o arquivo do Facebook funcionar: em vez de uma **pasta por foto** (e um atendente que precisa consultar cada pasta antes de buscar), eles juntaram as fotos em **álbuns gigantes** e guardaram uma **fichinha por foto na cabeça do atendente**, de modo que buscar uma foto leva uma única ida à prateleira.
- As fotos são **quentes quando novas e frias quando velhas**. A sala dos fundos move as antigas para um armazenamento mais barato, que mantém a mesma segurança com menos cópias.

---

## TL;DR for engineers

- **Fotos são blobs imutáveis:** criadas uma vez, lidas muitas vezes, raramente apagadas `[CONFIRMED]` (f4).
- **A parte cara de bilhões de arquivos pequenos são os metadados, não os dados.** A solução do Haystack: empacotar muitas fotos em **arquivos de volume de ~100 GB** e manter um **índice compacto em memória** (offset e tamanho por foto), de modo que uma leitura custa cerca de uma operação de disco `[CONFIRMED]` (Haystack).
- **Três componentes:** Directory (mapeamento lógico→volume físico, placement das escritas), Cache (uma CDN interna), Store (os arquivos de volume). A CDN externa absorve a cabeça popular, o Haystack a cauda longa `[CONFIRMED]`.
- **A temperatura importa.** A taxa de requisições cai com a idade, então as fotos novas vivem em storage quente (Haystack, com replicação tripla) e depois são movidas para o **f4**, que usa erasure coding **Reed-Solomon (10,4)** e XOR entre datacenters para reduzir o fator de replicação efetivo de **3,6 para 2,8 e depois 2,1** `[CONFIRMED]`.
- **Upload (padrão moderno):** o cliente envia **direto ao blob storage** com uma pre-signed URL de curta duração, para que os bytes grandes contornem os servidores de aplicação. Os derivados (miniaturas, tamanhos) são produzidos **de forma assíncrona** `[INDUSTRY PATTERN]` (o mecanismo de presigned-URL é `[CONFIRMED]` na documentação da AWS).

---

## 1. Requirements (design framing)

**Funcionais:** enviar fotos (individuais e álbuns, arquivos grandes, redes móveis instáveis) · ver em vários tamanhos · apagar · metadados básicos (dono, horário, privacidade) · visualização global rápida.

**Não funcionais:** **durabilidade** (uma foto perdida é uma perda visível ao usuário) · baixa latência de leitura, especialmente para fotos recentes · **custo por foto armazenada** na casa dos bilhões de objetos · disponibilidade diante de falhas de disco, host, rack e datacenter · escritas escaláveis (um bilhão de fotos por semana na época do Haystack).

**Escala conforme declarada nos papers:** Haystack (2010): "over 260 billion images, which translates to over 20 petabytes of data", com usuários enviando "one billion new photos (~60 terabytes) each week". f4 (2014): "As of February 2014, Facebook stored over 400 billion photos", e o f4 guardava "over 65PBs of logical BLOBs" `[CONFIRMED]`.

---

## 2. Upload path

### Modern pattern: direct-to-storage with a pre-signed URL `[INDUSTRY PATTERN]`

1. O cliente pede à API para iniciar um upload (`POST /photos` com tamanho e tipo). A API cria um registro da foto em estado `pending` e devolve uma **pre-signed URL**.
2. O cliente faz `PUT` dos bytes direto no blob storage. Arquivos grandes usam multipart/resumable upload.
3. O blob storage emite um evento (ou o cliente chama "complete"). Um worker valida o arquivo (tipo, tamanho, varredura de malware), escreve os **derivados** e muda a foto para `ready`.

Por que funciona, segundo a documentação da AWS `[CONFIRMED]`: uma presigned URL concede "time-limited access to objects" e "allows an upload without requiring another party to have AWS security credentials". Ela nomeia um bucket, uma chave, um método HTTP e uma expiração, e pode ser usada várias vezes até expirar. Com o SDK, a expiração pode chegar a **7 dias**, mas com credenciais temporárias a URL expira junto com elas. A AWS chama as presigned URLs de "bearer tokens", então trate-as como segredos: mantenha a expiração curta, restrinja a chave e verifique a integridade com checksums. Note também: se a chave existe, "Amazon S3 replaces the existing object", então gere chaves únicas por upload.

Escolhas de design para dizer em voz alta `[INDUSTRY PATTERN]`: mantenha os servidores de aplicação fora do caminho dos dados · torne a geração de derivados **idempotente** (mesma entrada → mesmas saídas, seguro repetir) · guarde o **original** intocado e derive a partir dele · remova ou normalize os metadados (ex.: EXIF de localização) por privacidade.

### What Facebook actually did in Haystack (2010) `[CONFIRMED]`

O upload passava **por um web server**: o usuário envia os dados a um web server, que pede ao Directory um **volume lógico habilitado para escrita**, atribui um **photo id único** e escreve em **cada volume físico** mapeado a esse volume lógico. O web server redimensiona cada foto para **quatro tamanhos**, armazenados como needles separados com a mesma chave e "alternate keys" diferentes. Os uploads de álbuns são **agrupados em lote**, porque os discos são melhores em escritas sequenciais grandes `[CONFIRMED]`.

Isso contrasta com o padrão moderno acima: o design do Haystack é anterior aos uploads no estilo presigned-URL, e sua camada web fazia o redimensionamento. Ambos são válidos, em eras diferentes.

---

## 3. Haystack: why the obvious design was slow, and the fix

### The NFS design and its problem `[CONFIRMED]`
Cada foto era um arquivo separado em appliances NAS via NFS. Ler uma exigia várias operações de disco só para os metadados ("one (or typically more) to translate the filename to an inode number, another to read the inode from disk, and a final one to read the file itself"). Colocar milhares de arquivos por diretório era ineficiente. Centenas por diretório ainda exigiam cerca de três operações por imagem. Só uma CDN não resolvia, porque a cauda longa das fotos menos populares tipicamente erra a CDN, e pôr todas em cache não é custo-efetivo.

### The Haystack design `[CONFIRMED]`
- **Store:** máquinas com volumes físicos, cada um "a very large file (100 GB)", agrupados entre máquinas em **volumes lógicos**. Uma escrita num volume lógico vai para todos os seus volumes físicos, o que protege contra falhas de disco, bugs de controladora e assim por diante.
- **Needle:** uma foto armazenada dentro de um volume: magic number de cabeçalho, cookie, chave de 64 bits (photo id), chave alternativa de 32 bits (o tipo de tamanho), flags (deleted), tamanho, dados, magic number de rodapé, checksum dos dados, padding até 8 bytes.
- **Índice em memória:** por volume, mapeia (key, alternate key) → flags, tamanho, offset. Uma leitura é: consulta em memória, um seek, leitura do needle, verificação de cookie e checksum.
- **Append-only:** as escritas acrescentam um needle de forma síncrona e atualizam o mapa em memória. Uma "sobrescrita" (ex.: uma rotação) acrescenta um novo needle com a mesma chave. A versão mais recente é a de maior offset.
- **Delete:** marca a flag de deleted em memória e, de forma síncrona, no needle. O espaço é recuperado depois por **compaction**, que copia os needles vivos para um novo arquivo e troca de forma atômica. Cerca de **25%** das fotos são apagadas ao longo de um ano.
- **Arquivo de índice:** um checkpoint do mapa em memória escrito de forma assíncrona para acelerar restarts. Needles sem registros de índice ("orphans") são reparados no restart.
- **Custo de memória:** cerca de **10 bytes de memória principal por foto**, 40 bytes para os quatro tamanhos de uma imagem, contra 536 bytes de um `xfs_inode_t` do Linux `[CONFIRMED]`.
- **Directory:** mapeamento lógico→físico, balanceamento de carga de escrita/leitura, decide entre CDN e Cache, marca volumes como somente leitura. Guardado num banco replicado acessado via PHP com memcache.
- **Cache:** uma hash table distribuída interna, endereçada pelo photo id, que protege as máquinas Store habilitadas para escrita. Ela só guarda uma foto em cache se a requisição vier **diretamente de um usuário** (não da CDN) e a foto for buscada de uma máquina **habilitada para escrita**.
- **A URL** codifica o caminho: `http://<CDN>/<Cache>/<Machine id>/<Logical volume, Photo>`. O **cookie**, um número aleatório atribuído pelo Directory no upload e embutido na URL, impede que se adivinhem URLs de fotos válidas.
- **Tratamento de falhas:** uma tarefa em background, o **pitchfork**, faz health checks das máquinas Store e marca como somente leitura os volumes de máquinas com falha. Um **bulk sync** raro a partir de uma réplica reinicia uma máquina, levando "hours" porque o volume de dados excede muito a velocidade da NIC.

---

## 4. f4: moving warm photos to cheaper storage `[CONFIRMED]` (OSDI '14)

**Insight:** a idade prevê a temperatura. "The request rate for week-old BLOBs is an order of magnitude lower than for less-than-a-day old content for eight of nine examined types", e para seis dos nove tipos ela cai 100× em menos de 60 dias. Delimitador hot-para-warm: cerca de um mês para a maioria dos tipos, **três meses para Photos**, e as Profile Photos não são movidas para o storage warm. O Haystack faz replicação tripla, o que "results in over provisioning from a throughput perspective" para dados warm.

**Arquitetura geral:** uma pilha de caching, uma **camada transformer** (transformações pesadas em computação, escaladas de forma independente), uma **camada router** (esconde o sistema de storage e viabiliza a migração entre eles) e o storage hot (Haystack). Os BLOBs novos são agregados em volumes no Haystack até suas taxas de requisição e de delete esfriarem, e então migram para o f4.

**Fator de replicação efetivo** = tamanho físico ÷ tamanho lógico. Com 3 réplicas e RAID-6 sobre 12 discos por nó, é **3,6**.

| Configuração | Fator de replicação efetivo | Como |
|---|---|---|
| Haystack | 3,6 | 3 réplicas × RAID-6 em 12 discos |
| f4, uma cell | 1,4 | Reed-Solomon **(10,4)**: 10 blocos de dados + 4 de paridade. Blocos distribuídos em racks diferentes |
| f4, 2 datacenters | 2,8 | Cell replicada num segundo datacenter |
| f4, geo XOR (em implantação na época) | **2,1** | O XOR de blocos "buddy" de volumes em dois datacenters é guardado num terceiro. (1,4×2 + 1,4)/2 = 2,1 |

- Uma cell fica em um datacenter: **14 racks de 15 hosts com 30 × discos de 4 TB por host** (na época). Ela trata apenas volumes **locked** (somente leitura), então suporta só leituras e deletes.
- **Deletes** sem compaction: cada BLOB é **criptografado** com uma chave por BLOB guardada num key store separado. Apagar a chave torna o BLOB ilegível. Isso também elimina o arquivo de journal do Haystack.
- Os arquivos de índice têm **replicação tripla** (pequenos demais para valer a pena codificar). A descriptografia acontece na **camada router**, para poder escalar de forma independente do storage.
- Componentes de uma cell: storage nodes (Index API e File API), name nodes (primary-backup), **backoff nodes** que reconstroem leituras quando faltam blocos, rebuilder nodes e coordinator nodes.
- **Trade-off:** o erasure coding dá menos overhead de armazenamento ao custo de "increased rebuild and recovery times under failure and lower maximum read throughput".

---

## 5. Serving photos `[INDUSTRY PATTERN]` unless marked

- **URLs imutáveis:** inclua um hash de conteúdo ou uma versão, para que o cache da CDN seja seguro para sempre e uma foto substituída ganhe uma nova URL. (A regra append-only do Haystack, em que uma foto alterada é um novo needle com a mesma chave, é o análogo no storage.)
- **Tamanhos:** gere um conjunto fixo de derivados (o Haystack usava quatro) em vez de redimensionar a cada requisição. Alternativamente, redimensione sob demanda e guarde em cache. O trade é storage vs CPU e latência.
- **CDN na frente:** serve a cabeça popular. A origem só vê os misses, então dimensione-a para a cauda longa `[CONFIRMED]` (motivação do Haystack).
- Os **metadados** (dono, privacidade, álbum) ficam num store separado dos bytes. Na descrição do f4, a camada web guarda um **handle** do BLOB no graph store (Tao) junto com as demais relações, e monta as URLs a partir dele na hora da leitura `[CONFIRMED]`.
- **Privacidade ao apagar:** apagar uma chave de criptografia (f4) é uma forma de tornar os bytes ilegíveis imediatamente, mesmo quando a remoção física é preguiçosa.

---

## ⚠️ Reviewer notes

1. **Não apresente o Haystack como "como o Instagram armazena fotos".** Os papers falam do Facebook, e a arquitetura própria do Instagram não é descrita nos papers que lemos. Muitas respostas de entrevista confundem isso.
2. **"S3 + CDN" é uma resposta boa, mas esconde a lição de verdade.** O Haystack e o f4 existem porque o overhead de metadados por objeto e de replicação domina na casa dos bilhões de objetos pequenos. Se você propuser o S3, esteja pronto para dizer por que as mesmas pressões se aplicam ou não ao seu caso.
3. **Presigned URLs são bearer tokens.** Vazar uma concede acesso até ela expirar. Expiração curta e chaves únicas importam.
4. **Os números envelhecem.** Os números de 2010 e 2014 (260 B de imagens, 400 B de fotos, 65 PB no f4, 3,6→2,1) são o que os autores relataram na época. O artigo diz "We are currently deploying geo-replicated XOR coding", então o número 2,1 descreve um rollout em andamento.
5. **O "2,1" do f4 é um fator de replicação efetivo, não durabilidade.** Ele diz quanto espaço bruto é usado por byte lógico.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não dos papers. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **durabilidade/recuperabilidade**, **eficiência de custo**, **performance** (leituras com um único seek, CDN), **escalabilidade**, **segurança** (URLs impossíveis de adivinhar, exclusão baseada em chave).
- **Estilo (Ch 13/17):** **service-based** no nível macro (camada web, Directory, Cache, Store, depois router, transformer e a camada fria). Dentro do store é um cluster **shared-nothing** de cells.
- **Quanta (Ch 7):** o storage hot (Haystack) e o storage warm (f4) são **quanta separados com características diferentes**: um ajustado para IOPS, o outro para eficiência de armazenamento. A camada router é a costura que permite aos blobs migrar entre eles.
- **Trade-off (First Law, Ch 1):** **custo vs throughput/latência.** O erasure coding economiza bytes mas custa tempo de rebuild e throughput de leitura, então só é aplicado quando os dados esfriam.
- **Esboço de ADR (Ch 19):** *"Vamos manter as fotos novas em storage hot com replicação tripla e migrá-las para storage warm com erasure coding após cerca de três meses. Aceitamos rebuilds mais lentos e menor throughput por BLOB nas fotos antigas."*
- Em linguagem simples: deixe as cópias novas no balcão da frente e mande as antigas para o arquivo, onde você guarda menos cópias mas ainda cobre os mesmos riscos.

---

## Interview questions to practice

1. Por que um arquivo por foto é uma má ideia na casa dos bilhões de fotos? O que o Haystack muda?
2. Projete o caminho de upload para fotos de 20 MB em redes móveis instáveis. Quando você cria o registro no banco, e o que acontece se o cliente nunca concluir?
3. Como você serve quatro tamanhos de cada foto? Pré-gera, ou redimensiona sob demanda? Defenda sua escolha.
4. Como você apagaria uma foto rapidamente quando a recuperação física de espaço é preguiçosa?
5. Por que você migraria fotos antigas para um storage com erasure coding? O que se perde?
6. Como você impede que as pessoas adivinhem URLs de fotos?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: tamanhos, privacidade, derivados, retenção.
2. Estimar: fotos por dia, tamanhos, crescimento de storage.
3. API: iniciar upload, concluir, obter a URL da foto.
4. Design: caminho de upload, blob store, workers de derivados, CDN.
5. Deep dive: needles do Haystack e erasure coding do f4.
6. Falhas e escala: uploads abandonados, fotos quentes, deletes.

**Se crescer 10×**
- Os arquivos por foto quebram primeiro: empacote as fotos e indexe em memória.
- O custo de storage domina: use camadas por idade e erasure coding nos dados warm.
- Carga na origem: dimensione a CDN para a cauda longa.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Por que um arquivo por foto é uma má ideia na casa dos bilhões de fotos?</summary>

Ler uma foto exigia várias operações de disco só para os metadados. Empacotar as fotos em arquivos grandes com um índice em memória reduziu uma leitura a cerca de um seek.

</details>

<details><summary>Projete o caminho de upload para fotos de 20 MB em redes instáveis.</summary>

Crie um registro pending, entregue um conjunto de pre-signed URLs de partes com vida curta (o multipart do S3 precisa de uma por parte, mais as chamadas de initiate e complete) ou uma URI de sessão retomável, deixe o cliente retomar por parte e depois processe de forma assíncrona. Um sweeper limpa os uploads que nunca são concluídos.

</details>

<details><summary>Como apagar rapidamente quando a recuperação de espaço é preguiçosa?</summary>

O f4 criptografa cada blob com sua própria chave e apaga a chave, o que torna os dados ilegíveis imediatamente.

</details>

## 📚 Further reading

- [Haystack, OSDI '10](https://www.usenix.org/legacy/event/osdi10/tech/full_papers/Beaver.pdf) · [f4, OSDI '14](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-muralidhar.pdf)
- [AWS: presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [System Design Primer: scaling to millions of users, CDN and object storage topics](https://github.com/donnemartin/system-design-primer) (secundária)
- Relacionado neste repositório: [05 Object storage](05-object-storage-s3.md) (erasure coding e durabilidade), [06 File sync](06-file-sync-dropbox.md) (blocos endereçados por conteúdo), [`neokim-post/03` YouTube](https://github.com/allmonty/study/blob/main/architecture/neokim-post/03-how-youtube-works.md) (um fluxo parecido de upload e depois transcode).

## Sources and provenance

> **Kind:** real-system para a metade de storage, reference design para a metade de upload. Os papers **Haystack** (OSDI 2010) e **f4** (OSDI 2014) do Facebook descrevem como um store de fotos muito grande foi de fato construído. Como um app moderno aceita uploads (upload direto pre-signed, pipeline de derivados) é um padrão comum, documentado por fornecedores de object store mas não por uma única empresa de "app de fotos", por isso recebe a tag `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-29 em texto completo:** [Beaver et al., *Finding a needle in Haystack: Facebook's photo storage*, OSDI '10](https://www.usenix.org/legacy/event/osdi10/tech/full_papers/Beaver.pdf) · [Muralidhar et al., *f4: Facebook's Warm BLOB Storage System*, OSDI '14](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-muralidhar.pdf) · [AWS docs: presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
> **Dated material:** os papers são de 2010 e 2014. Os números descrevem esses anos, e o sistema atual do Facebook evoluiu desde então. Não lemos posts mais novos do Facebook ou do Instagram para esta nota.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão, não declarada para uma empresa específica · `[SPECULATIVE]` plausível.

---
## ✅ Verification log

*Fact-check, 2026-10-27, from the extracted text of both papers and the AWS docs page.* Verified, with notes on what was dropped or scoped:
- Verified in the Haystack paper: 260 billion images / 20 PB / one billion (~60 TB) photos per week; NFS design metadata-read costs; three components; 100 GB physical volumes, logical volumes written to all physical volumes; needle fields; in-memory mapping and single-seek read; cookie assigned by the Directory; append-only writes and highest-offset-wins; delete flag and compaction; ~25% deleted per year; index file with orphans; pitchfork; bulk-sync recovery in hours; ~10 bytes of memory per photo, 40 bytes per four sizes vs 536 bytes for `xfs_inode_t`; four sizes per upload; batch uploads; Cache admission rules; URL layout; Directory's four jobs.
- Verified in the f4 paper: 400 billion photos (Feb 2014), 65 PB, 3.6 → 2.8 → 2.1; the 3.6 derivation; age/temperature findings and the "order of magnitude" quote; three-month hot/warm threshold for Photos and one month for most other types; Reed-Solomon (10,4), XOR geo-coding and the (1.4×2+1.4)/2 arithmetic (re-derived by hand); cell geometry; locked volumes only; per-BLOB encryption with key deletion; triple-replicated index files; router/transformer tiers; BLOB handle stored in Tao.
- Verified in AWS docs: presigned URL semantics, 7-day SDK maximum, temporary-credential expiry, "bearer tokens", overwrite-on-same-key, checksum support.
- Dropped: any claim about Instagram or Pinterest storage. We did not read their posts, so none is made.
- Scoped: "Haystack uploads go through a web server" describes the 2010 paper. We do not claim it for any current system.
- Scoped: the modern upload pipeline and image-serving advice are `[INDUSTRY PATTERN]`, not tied to a company.
- Not verified: Facebook's current architecture, and what became of the "proactively push new photos into the Cache" optimization the Haystack paper says it planned.
- Re-checked 2026-10-29 against fresh copies of both papers: every number in the key numbers, the scale paragraph and the f4 table (260 billion, 20 PB, one billion photos and about 60 TB a week, 10 and 40 bytes against 536, 25% deleted a year, 400 billion in February 2014, 65 PB, 3.6, 2.8, 2.1, 14 racks of 15 hosts with 30 4 TB drives, one month and three months thresholds, Profile Photos kept in Haystack, the Tao handle). The one phrase that was in quotation marks but not in the paper ("being deployed") now quotes the paper's own sentence.
- Quote audit (2026-10-27): restored an omitted phrase in the Haystack inode quote ("one (or typically more) …").
- Corrected (independent review, 2026-10-27): the upload outline now says S3 multipart needs one pre-signed URL per part, as note 12 shows.
