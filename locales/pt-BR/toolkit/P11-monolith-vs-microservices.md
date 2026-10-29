# P11 — Monolith or microservices: choosing a deployment shape

*Uma introdução a uma das decisões de arquitetura mais debatidas. As definições e o argumento de custo vêm de Fowler e Lewis (2014) e de dois textos curtos de acompanhamento de Fowler (2015); as evidências vêm dos relatos das próprias empresas, Shopify (2019) e Prime Video (2023); o método de decisão é nosso raciocínio e está rotulado como tal. O texto não afirma qual estilo é melhor. Ambas as fontes e ambas as empresas dizem que depende.*

## At a glance

Um **monolith** é uma única unidade implantável; uma **microservice architecture** divide uma aplicação em muitos serviços pequenos implantados de forma independente. A divisão proporciona implantação e escalabilidade independentes, além de um limite explícito (Fowler e Lewis observam que muitas pessoas acreditam que ele se degrada menos do que um monolith, embora digam ser cedo demais para ter certeza). O custo é um sistema distribuído: chamadas de rede, falhas parciais, dados espalhados por muitos repositórios e o ferramental para implantar e observar tudo isso. Fowler chama esse custo de **microservice premium** e diz que ele só compensa quando o sistema é suficientemente complexo. Dois relatos públicos mostram a escolha indo em cada direção: a Shopify manteve uma única base de código e tratou de impor limites dentro dela (um **modular monolith**), e uma equipe de monitoramento do Prime Video recolapsou um design distribuído em um único processo e reduziu o custo de infraestrutura em mais de 90%.

**Em 60 segundos:** comece pelo problema, não pelo estilo. Pergunte o que está realmente doendo: uma base de código emaranhada demais para mudar, implantações que se bloqueiam mutuamente, um componente que precisa escalar sozinho ou equipes que não conseguem trabalhar em paralelo. Corrija os limites primeiro (módulos com interfaces impostas e dados sob propriedade exclusiva), porque serviços só funcionam bem sobre bons limites. Extraia um serviço quando uma necessidade específica (escalabilidade independente, cadência de lançamento independente, um limite de equipe) superar o custo operacional — e não antes.

---

## 1. What the two styles are `[CONFIRMED]` (Fowler and Lewis, 2014; Shopify, 2019)

Fowler e Lewis definem o estilo microservice como "an approach to developing a single application as a suite of small services, each running in its own process". Eles acrescentam que "These services are built around business capabilities and independently deployable by fully automated deployment machinery." A Shopify, citando Simon Brown, define o termo contrastante: "A modular monolith is a system where all of the code powers a single application and there are strictly enforced boundaries between different domains." Nossa leitura `[INDUSTRY PATTERN]`: os eixos úteis são distintos: **quantas unidades de implantação** (uma ou várias) e **quão rígidos são os limites** (impostos ou por convenção). Um monolith sem limites impostos e um conjunto de serviços que compartilham um banco de dados estão ambos no extremo ruim do segundo eixo.

## 2. The cost side: the microservice premium `[CONFIRMED]` (Fowler, 2015; Fowler and Lewis, 2014)

A nota de 2015 de Fowler diz que microservices trazem custos próprios: "you have to work on automated deployment, monitoring, dealing with failure, eventual consistency, and other factors that a distributed system introduces", e que esse premium "can slow down your development considerably" quando o sistema não é complexo o suficiente para precisar deles. Sua diretriz é direta: "don't even consider microservices unless you have a system that's too complex to manage as a monolith". Ele acrescenta "The majority of software systems should be built as a single monolithic application." e que "Many of the problems ascribed to monoliths aren't essential to that style."

Três custos aparecem nas fontes:

- **Os limites são mais difíceis de mover.** Fowler e Lewis: quando os componentes são serviços, "refactoring is much harder than with in-process libraries". Um limite errado é barato de corrigir em uma única base de código e caro quando distribuído entre serviços.
- **Dados e transações.** "Distributed transactions are notoriously difficult to implement", então os serviços se contentam com eventual consistency. Os padrões para conviver com isso estão em [P03](P03-distributed-transactions.md).
- **Disponibilidade se multiplica.** Com muitas chamadas síncronas em cadeia, "the downtime of your system becomes the product of the downtimes of the individual components" (em termos simples, as disponibilidades se multiplicam, de modo que uma cadeia de dez serviços com 99,9% de disponibilidade cada fica com cerca de 99,0% de disponibilidade).

As fontes também enfatizam que a palavra microservice cobre tamanhos muito diferentes: Fowler viu "microservice systems vary from a team of 60 with 20 services to a team of 4 with 200 services", e diz não estar claro o quanto o tamanho do serviço altera o premium.

## 3. Should you start with a monolith? `[CONFIRMED]` as Fowler's observation, not a law

A nota *MonolithFirst* de Fowler relata um padrão: "Almost all the successful microservice stories have started with a monolith that got too big and was broken up", enquanto em quase todos os casos que ele conhece de sistemas construídos como microservices desde o início, "it has ended up in serious trouble". Seus motivos são que ainda não se sabe se o produto é útil (portanto a velocidade importa mais do que o premium), e que limites estáveis de serviço são difíceis de definir antes de o domínio ser compreendido. Ele é aberto quanto aos limites: "it is by no means unanimous" (o contra-argumento é que começar com serviços constrói o hábito), e "You cannot assume that you can take an arbitrary system and break it into microservices", porque a maioria dos sistemas acumula dependências demais entre módulos para ser dividida de forma sensata. Ele lista outras rotas: descasque serviços nas bordas, construa um monolith destinado a ser descartado ou comece com alguns serviços grosseiros. Esta é a observação de um praticante a partir das histórias que ouviu, não um resultado medido.

## 4. Two companies, two answers

**Shopify chose a modular monolith `[CONFIRMED]`** (blog post, 21 February 2019). A Shopify descreve "one of the largest Ruby on Rails codebases in existence", construída como um monolith. Por volta de 2016, as desvantagens superavam os benefícios: "The application was extremely fragile with new code having unexpected repercussions", os testes eram lentos e novos desenvolvedores precisavam de contexto demais. Eles consideraram microservices e pesaram seus custos (mais pipelines e infraestrutura, chamadas de rede que adicionam latência e reduzem a confiabilidade a cada chamada, refatorações entre serviços mais difíceis). Sua escolha: "We chose to evolve Shopify into a modular monolith, meaning that we would keep all of the code in one codebase, but ensure that boundaries were defined and respected between different components." Cada componente recebeu "a clean dedicated interface with domain boundaries expressed through a public API and took exclusive ownership of its associated data", e uma ferramenta interna rastreava violações de limites. O post diz que o isolamento ainda estava em andamento: impor limites no código era um plano, não um resultado. O post é de 2019, portanto o que a Shopify faz hoje não é afirmado aqui.

**A Prime Video team consolidated one service `[CONFIRMED]`** (engineering post, 22 March 2023). A ferramenta de monitoramento de qualidade de áudio/vídeo da equipe foi inicialmente construída como componentes distribuídos orquestrados pelo AWS Step Functions com AWS Lambda, "a good choice for building the service quickly". Ela atingiu "a hard scaling limit at around 5% of the expected load". O Step Functions era ao mesmo tempo o gargalo e um custo (ele cobra por transição de estado, e o serviço realizava várias por segundo de cada stream), e passar quadros de vídeo entre componentes através do Amazon S3 adicionava muitas chamadas custosas. Eles empacotaram os componentes em um único processo no EC2 e ECS, o que eliminou o armazenamento intermediário, e relatam: "Moving our service to a monolith reduced our infrastructure cost by over 90%." O trade-off que apontam: os detectores agora escalam apenas verticalmente dentro de uma instância, de modo que quando a capacidade acabava eles clonavam o serviço, cada cópia executando um subconjunto dos detectores, atrás de uma camada leve de distribuição de requisições. Sua conclusão é o ponto central deste texto: a escolha entre microservices ou componentes serverless "has to be made on a case-by-case basis".

**Nossa leitura (`[INDUSTRY PATTERN]`, não das fontes):** nenhum relato diz que microservices são ruins. O problema da Shopify eram limites ausentes; o post relata que seu trabalho de isolamento já estava trazendo resultados (era possível substituir seu motor de impostos) enquanto chamava o isolamento completo de tarefa em andamento. O da Prime Video era um design específico (transições de estado de orquestração por segundo e dados em massa passados por armazenamento de objetos) em uma escala específica; trata-se de um serviço, não da empresa. Leia-os como exemplos de escolha do formato adequado a cada problema, que é o que ambas as fontes concluem.

## 5. Teams and boundaries: Conway's law `[CONFIRMED]` (Conway, 1968)

O artigo de Melvin Conway afirma a tese: "organizations which design systems (in the broad sense used here) are constrained to produce designs which are copies of the communication structures of these organizations." Fowler e Lewis usam isso para defender a divisão de equipes em torno de capacidades de negócio para que os serviços as acompanhem. Nossa leitura `[INDUSTRY PATTERN]`: os limites de serviço são também limites de equipe, portanto uma divisão de serviço que não corresponda a quem possui o quê tenderá a ser desfeita pela comunicação, e uma divisão de equipe que não corresponda ao código produzirá interfaces inadequadas. Este é o motivo mais forte para dividir que não tem a ver com tecnologia.

## 6. A way to decide `[INDUSTRY PATTERN]`

Este é nosso raciocínio, uma lista de verificação e não uma regra extraída de qualquer fonte.

| Signal | Leans toward |
|---|---|
| Uma equipe pequena, produto ainda sendo descoberto | Uma unidade implantável |
| O código está emaranhado, mudanças quebram testes distantes | Primeiro, limites de módulo impostos (mesmo em uma única unidade); serviços depois, se ainda necessário |
| Um componente precisa de escalabilidade, hardware ou cadência de lançamento muito diferentes | Extraia esse componente como serviço |
| Muitas equipes bloqueadas em um único trem de lançamento | Divida por linhas de equipe e capacidade |
| Ainda não há prática de deploy automatizado, monitoramento ou plantão | Fique com unidades maiores e em menor número até tê-las |
| Os componentes trocam grandes volumes de dados ou se chamam muitas vezes por requisição | Mantenha-os em um único processo (o caso do Prime Video) |
| Uma migração é necessária | Strangler fig, veja [P10](P10-changing-systems-safely.md) |

Os custos seguem o formato: veja [P08](P08-cost-as-a-design-input.md) para tratar custo como entrada de design e [P07](P07-slos-and-incidents.md) para o comportamento de falha que você assume a cada chamada de rede. No atlas, [09 Discord](../systems/09-discord.md) descreve serviços de dados posicionados entre um monolith de API e seus bancos de dados, e [P03](P03-distributed-transactions.md) cobre os padrões de consistência que serviços distribuídos precisam.

---

## Questions to practise

1. Quais são os dois eixos independentes na questão monolith-ou-microservices, e onde o modular monolith se situa?
2. Liste três custos de microservices que um monolith não tem, com a falha que cada um causa.
3. Por que Fowler argumenta que os limites são mais difíceis de acertar em serviços do que em módulos?
4. O que a Shopify mudou, o que manteve e que problema isso resolveu?
5. Por que consolidar um serviço reduziu o custo do Prime Video, e que limite de escalabilidade ele aceitou em troca? Por que isso não é um argumento contra microservices em geral?
6. Como a Conway's law afeta o ponto de corte de um limite de serviço?
7. Uma equipe de seis pessoas opera um produto em uma única base de código e quer migrar para microservices "para escalar". O que você pergunta primeiro?

## Practice

Tome um sistema do atlas com vários contêineres (por exemplo, [13 Netflix](../systems/13-netflix.md) ou [09 Discord](../systems/09-discord.md)). Para cada contêiner, diga se você o implantaria separadamente, usando apenas os sinais da seção 6. Em seguida, argumente o contrário para aquele sobre o qual você tinha mais certeza, e anote que evidências mudariam sua opinião (um limite de escalabilidade medido, um limite de equipe, um conflito de cadência de lançamento).

---

## Sources and provenance

> **Sources read on 2026-10-27:** James Lewis and Martin Fowler, [*Microservices*](https://martinfowler.com/articles/microservices.html) (25 March 2014) · Martin Fowler, [*MonolithFirst*](https://martinfowler.com/bliki/MonolithFirst.html) (3 June 2015) and [*Microservice Premium*](https://martinfowler.com/bliki/MicroservicePremium.html) (13 May 2015) · Kirsten Westeinde, [*Deconstructing the Monolith*](https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity) (Shopify Engineering, 21 February 2019) · Marcin Kolny, [*Scaling up the Prime Video audio/video monitoring service and reducing costs by 90%*](https://www.primevideotech.com/video-streaming/scaling-up-the-prime-video-audio-video-monitoring-service-and-reducing-costs-by-90) (22 March 2023; the original page now redirects, so we read the [Internet Archive copy](https://web.archive.org/web/2023/https://www.primevideotech.com/video-streaming/scaling-up-the-prime-video-audio-video-monitoring-service-and-reducing-costs-by-90)) · Melvin Conway, [*How Do Committees Invent?*](http://www.melconway.com/Home/Committees_Paper.html) (Datamation, April 1968).
> **Dated material:** the definitions are from 2014 and the evidence from 2019 and 2023; what Shopify and Prime Video do today is not claimed.
> **Not read:** Shopify's later tooling and writing on modular monoliths, any measurement of microservice vs monolith productivity (the sources are practitioners' accounts, not studies), Sam Newman's and other book-length treatments, and Amazon's other architecture posts.
> **Tags:** `[CONFIRMED]` stated by a primary source we read · `[INDUSTRY PATTERN]` standard practice or our reading of the sources · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in Fowler and Lewis: the definition of the microservice style, the business-capability and independent-deployment wording, the refactoring cost, the distributed-transactions remark, the multiplied downtime, and the Conway's-law framing.
- Verified in Fowler's two notes: the premium wording, the guideline and the "majority" sentence, the 60-versus-4 team example, the monolith-first observation and its stated limits (not unanimous, cannot assume a system can be split), and the alternative routes.
- Verified in Shopify's post: the codebase description, the 2016 tripwires, the choice of a modular monolith and its definition, the component interface and data ownership, the in-house boundary tool, and that enforcement was still planned.
- Verified in the Prime Video post: the architecture before and after, the Step Functions and S3 cost and scaling causes, the 5% limit, the over 90% figure, the vertical-scaling trade-off and the cloned-service workaround, and the case-by-case conclusion.
- Verified in Conway's paper: the thesis sentence in its conclusion.
- Not claimed: how Shopify or Prime Video operate now; any claim that one style is better; that Prime Video's result transfers to other systems.
- Our reasoning, not from the sources: the "Our reading" paragraphs, the Conway's-law application, and the decision table in section 6.
