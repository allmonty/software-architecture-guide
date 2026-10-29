# P14 — Multi-tenancy: sharing a system between customers without sharing their problems

*Uma introdução a como atender muitos clientes (tenants) a partir de um único sistema. O vocabulário e as orientações de isolamento vêm do whitepaper AWS SaaS Architecture Fundamentals (2022); os modelos de tenancy e as mitigações de noisy-neighbour do Microsoft Azure Architecture Center; um design real de schema compartilhado da plataforma Salesforce; o método de decisão é nosso raciocínio e está rotulado como tal. Descreve o tenancy no estilo SaaS, onde os clientes são organizações ou contas, não a física de máquinas virtuais compartilhando um host.*

## At a glance

Um **tenant** é um cliente (ou um grupo de usuários tratados como um único cliente) cujos dados e configurações devem ser mantidos separados dos de todos os outros tenants. **Multi-tenancy** significa que vários tenants compartilham parte ou toda a infraestrutura, o que torna o sistema mais barato de operar e atualizar do que um deployment por cliente. Isso também cria três problemas recorrentes: **isolation** (o tenant A jamais deve acessar os dados do tenant B), o **noisy neighbour** (a carga do tenant A não deve degradar o tenant B) e **operações por tenant** (custo, métricas, limites, atualizações e mover um tenant entre tiers). As fontes tratam o nível de compartilhamento como um espectro — de totalmente dedicado a totalmente compartilhado — e como uma decisão de negócios tanto quanto técnica.

**Em 60 segundos:** decida o que é um tenant, depois decida por camada (compute, dados, rede) se é compartilhada ou dedicada, com base em conformidade, custo e necessidades de noisy-neighbour — não por hábito. Isolation é um mecanismo próprio: autenticar um usuário não impede que ele leia as linhas de outro tenant. Coloque a identidade do tenant em cada requisição e em cada caminho de consulta, aplique-a abaixo do código de aplicação sempre que possível, limite o uso de recursos compartilhados por tenant e meça custo e carga por tenant desde o primeiro dia.

---

## 1. What a tenant is, and how much to share `[CONFIRMED]` (Azure Architecture Center; AWS)

O Azure começa com o problema de definição: para clientes corporativos, um tenant geralmente corresponde ao cliente, mas um cliente pode precisar de vários tenants (divisões, ou instâncias separadas de desenvolvimento e produção); para consumidores, um tenant pode ser uma pessoa, uma família ou um clube. O Azure insiste que "Selecting a tenancy model isn't only a technical decision. It's also a commercial decision.", pesando objetivos de negócio, conformidade, escala, capacidade de automação e SLAs. O trade-off é declarado sem rodeios: "If you expect your business to scale to a large number of customers, it's important to deploy shared infrastructure." Um deployment totalmente compartilhado é atraente porque "operating a solution that has shared components is less expensive than using individual resources for each tenant", enquanto stacks dedicados por tenant são o outro extremo, onde "cost efficiency is low because you don't share infrastructure among your tenants", mas os dados ficam isolados e é improvável que os tenants se afetem mutuamente.

Os modelos do Azure ficam entre os extremos: **vertical partitioning** mistura deployments compartilhados e dedicados (a maioria dos clientes em infraestrutura compartilhada, dedicada para quem precisa de mais desempenho ou isolamento, ou um deployment por geografia); **horizontal partitioning** compartilha algumas camadas e dedica outras (uma camada de aplicação com um banco de dados por tenant); e a página também aponta para o padrão Deployment Stamps (não lemos sua página; a ideia é replicar um deployment completo e atribuir tenants a ele). E "Instead of viewing isolation as a discrete property, consider it a spectrum": diferentes componentes podem ser mais ou menos isolados na mesma arquitetura. O vocabulário da AWS para a camada de dados é o par **silo** e **pool**: "In a siloed model, you have a distinct storage construct for each tenant with no co-mingled data", e no particionamento pooled os dados "is co-mingled and partitioned based on a tenant identifier that determines which data is associated with each tenant". Exemplo com DynamoDB: uma tabela por tenant é silo; o identificador do tenant na partition key de uma tabela compartilhada é pool. Misturar os dois (siloar alguns tenants ou alguns dados, agrupar o restante em pool) é o meio-termo prático; os modelos particionados do Azure acima são essa ideia aplicada no nível de deployment.

## 2. Isolation is not authentication `[CONFIRMED]` (AWS)

A AWS expõe o ponto central em uma página: "SaaS systems include explicit mechanisms that ensure that each tenant's resources—even if they run on shared infrastructure—are isolated." E: "the fact that a tenant user is authenticated does not mean that your system has achieved isolation." Autenticação e autorização garantem segurança, mas "a user could be authenticated and authorized, and still access the resources of another tenant." O isolation usa o **tenant context** da requisição atual para decidir quais recursos são acessíveis, para todos os usuários naquele tenant, e isso deve se manter independentemente de o tenant ter sua própria stack (políticas grosseiras de rede) ou compartilhar recursos em pool, como itens de tabela (políticas de granularidade fina). Uma segunda distinção: "Partitioning data does not ensure that the data is isolated." Como você armazena os dados do tenant e como você impede o acesso entre tenants são decisões separadas, embora a primeira influencie a segunda. Nossa leitura `[INDUSTRY PATTERN]`: a falha comum é um filtro de tenant ausente em um caminho de consulta; portanto, carregue a identidade do tenant a partir da borda em cada chamada, incorpore-a à camada de acesso a dados para que uma consulta não possa ser escrita sem ela, e teste o acesso entre tenants explicitamente. No atlas, [23 RAG assistant](../systems/23-rag-knowledge-assistant.md) mostra a mesma regra para documentos: a recuperação deve filtrar por permissão, não apenas pela interface. Para segurança de forma mais ampla, consulte [P06](P06-security-threat-modeling.md).

## 3. One shared schema, in practice `[CONFIRMED]` (Salesforce)

O brief de plataforma da Salesforce descreve o extremo do pooling: "A single shared multitenant database with a single schema that stores tenant-specific metadata and data", com um runtime que lê metadados para fornecer a aplicação personalizada de cada tenant. A personalização é armazenada como metadados, portanto "the platform does not create an actual table in a database or compile any code" quando um tenant define um objeto. A privacidade repousa em um identificador: "every org-specific record in shared database tables has an OrgID", e "When the kernel accesses the database, it uses this unique identifier to ensure that each org's activities are private." O mesmo brief descreve a proteção contra um tenant prejudicar os demais: "To prevent malicious or unintentional monopolization of shared, multitenant system resources, the platform has an extensive set of governors and resource limits associated with platform code execution", cobrindo tempo de CPU, memória, contagens de consultas e chamadas de saída, e consultas que o otimizador julga muito custosas "throw a runtime exception to the caller". O brief é a descrição do próprio fornecedor, sem data de leitura; mostra um design funcional, não o único possível.

## 4. The noisy neighbour `[CONFIRMED]` (Azure Architecture Center)

"The noisy neighbor problem occurs when one tenant's performance is degraded because of the activities of another tenant." Isso acontece com um tenant muito pesado e também quando muitos tenants pequenos atingem o pico simultaneamente. A página de antipadrões do Azure é franca ao afirmar que "Sharing a single resource inherently carries the risk of noisy neighbor problems that you can't completely avoid", e lista o que os provedores podem fazer: monitorar o uso geral e por tenant com alertas, **aplicar resource governance** (cotas via throttling ou rate limiting), provisionar mais capacidade (mais shards ou stamps), permitir que tenants adquiram capacidade reservada, rebalancear tenants entre instâncias (posicionando padrões de uso complementares juntos para suavizar picos), mover trabalhos pesados não urgentes para fora do horário de pico, restringir operações (contagem máxima de registros retornados ou tempo de consulta) e oferecer um tiering de qualidade de serviço. O modelo de horizontal partitioning acima é em si uma mitigação: dedicar o componente que carrega a maior parte da carga. Os limites de governadores da Salesforce são a mesma ideia incorporada na plataforma. Nossa leitura `[INDUSTRY PATTERN]`: os limites por tenant pertencem a várias camadas (taxa da API, concorrência, custo de consulta, parcela de background jobs), e os próprios limites são uma decisão de produto, razão pela qual geralmente seguem tiers. [02 Rate limiter](../systems/02-rate-limiter.md) cobre os mecanismos por usuário, e [P07](P07-slos-and-incidents.md) o lado do load-shedding.

## 5. Running it per tenant `[INDUSTRY PATTERN]`

Nosso raciocínio, com as dicas das fontes:

- **Custo.** Em um sistema pooled você não consegue ver o custo por tenant a menos que meça o uso por tenant; o Azure lista o rastreamento e a associação de custos aos tenants como um risco do modelo compartilhado. Consulte [P08](P08-cost-as-a-design-input.md).
- **Métricas e SLOs.** Marque toda métrica e log com o tenant, para que a interrupção ou lentidão de um tenant seja visível e para que um tenant grande não se dissolva numa média. Decida se os SLOs são por tier de tenant.
- **Blast radius e releases.** Um deployment compartilhado é mais simples de atualizar, mas, como o Azure observa, "also often riskier because changes might affect your entire customer base"; deployments dedicados por tenant permitem lançamentos progressivos (o Azure afirma esse benefício para eles; assumimos que se aplica também aos stamps). Compare com o argumento de complexidade em [P11](P11-monolith-vs-microservices.md), onde Fowler lista multi-tenancy entre as fontes de complexidade.
- **Mover tenants.** Projete o identificador de modo que um tenant possa ser movido do pool para uma stack dedicada (ou entre stamps) sem reescrever seu modelo de dados.
- **Limites da plataforma.** A infraestrutura compartilhada atinge os limites de escala da plataforma mais cedo (Azure: você "more likely to reach Azure resource scale limits when you have a shared set of infrastructure"); planeje sharding ou stamps com antecedência.

## 6. A way to choose `[INDUSTRY PATTERN]`

| Situation | Leans toward |
|---|---|
| Muitos clientes pequenos, custo reduzido, uso similar | Compute e dados em pool, tenant id em todo lugar, limites rigorosos por tenant |
| Poucos clientes grandes com exigências de conformidade ou desempenho | Stacks dedicadas (ou data stores dedicados) para eles, pool para os demais |
| Um componente carrega a maior parte da carga | Dedicar ou fazer sharding desse componente primeiro (horizontal partitioning) |
| Clientes em diferentes jurisdições | Deployment por região (stamps), tenants mapeados a uma região |
| Produto inicial, mix de tenants desconhecido | Manter a identidade do tenant no modelo de dados desde o início e adiar o isolation custoso até que um cliente precise dele |

---

## Questions to practise

1. Defina silo, pool e um modelo misto para a camada de dados, com um exemplo para um key-value store.
2. Por que autenticar um usuário não garante o isolation de tenant? O que o isolation acrescenta?
3. Dê dois modos pelos quais um sistema pooled pode vazar dados entre tenants apesar de autenticação correta.
4. O que é o problema do noisy-neighbour e quais são quatro mitigações?
5. Como você permitiria que um grande cliente saísse do pool compartilhado para sua própria stack?
6. O que você mediria por tenant e por quê?
7. Por que o modelo de tenancy é "uma decisão comercial" além de uma decisão técnica?

## Practice

Escolha um sistema do atlas que atende muitos clientes, como [23 RAG assistant](../systems/23-rag-knowledge-assistant.md) ou [02 Rate limiter](../systems/02-rate-limiter.md), e projete seu tenancy: defina um tenant, escolha compartilhado ou dedicado para compute, dados e o cache, indique onde a identidade do tenant é aplicada, escreva os limites por tenant que você definiria e liste o que você mediria por tenant. Em seguida, nomeie a única falha que você testaria primeiro (por exemplo, um caminho de consulta sem o filtro de tenant) e como.

---

## Sources and provenance

> **Sources read on 2026-10-27:** AWS, [*SaaS Architecture Fundamentals*](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/saas-architecture-fundamentals.html) (published 3 August 2022; the whitepaper carries a "historical reference only" notice), the pages [Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html) and [Data partitioning](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/data-partitioning.html), and the [SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-lens.html) introduction · Microsoft Azure Architecture Center, [*Tenancy models for a multitenant solution*](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models) and the [*Noisy Neighbor antipattern*](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/noisy-neighbor/noisy-neighbor) (Tenancy models page last updated 2025-06-27; the noisy-neighbour page shows no date) · Salesforce Architects, [*Platform Multitenant Architecture*](https://developer.salesforce.com/wiki/multi_tenant_architecture) technical brief (undated; read as served) · Martin Fowler, [*Microservice Premium*](https://martinfowler.com/bliki/MicroservicePremium.html) (13 May 2015), for the one remark cited in section 5.
> **Dated material:** the AWS paper is from 2022 and marked historical; the Azure and Salesforce pages are revised without dates; the concepts are stable, the product names are not.
> **Not read:** AWS's longer *SaaS Tenant Isolation Strategies* paper and the rest of the SaaS Lens, the Azure overview and checklists, the Weissman and Bobrowski SIGMOD 2009 paper on the Force.com platform (the ACM page was not fetchable), row-level security features of specific databases, and any measured data on tenant-isolation failures. The advice to tie limits to tiers and to carry the tenant identity in every call is our reasoning.
> **Tags:** `[CONFIRMED]` stated by a primary source we read · `[INDUSTRY PATTERN]` standard practice or our reading of the sources · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the AWS pages: the definition of tenant isolation, the distinction from authentication and authorization, the definitions of silo and pool partitioning and the DynamoDB example, and the statement that partitioning does not ensure isolation.
- Verified in the Azure tenancy-models page: the definition problem for B2B and B2C tenants, the commercial-decision wording, the shared-versus-dedicated cost trade-offs, vertical and horizontal partitioning and stamps, the isolation-as-a-spectrum wording, and the risks of the shared model.
- Verified in the Azure noisy-neighbour page: the definition, the unavoidable-risk statement and the provider mitigations.
- Verified in Salesforce's brief: the single shared schema, metadata-driven customisation, the OrgID mechanism, and the governors and resource limits.
- Not claimed: how any one company isolates tenants today; any figure for the cost of a tenancy model; that a mitigation works as well in your system.
- Our reasoning, not from the sources: the "Our reading" sentences, the pointers to atlas notes, section 5, and the table in section 6.
