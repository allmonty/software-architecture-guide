# 25 — AI Agent Platform (Tool Use and a Coding Agent)

*Um reference design construído sobre orientações publicadas (o "Building effective agents" da Anthropic), um protocolo publicado (o Model Context Protocol) e um método publicado (ReAct). Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um agent é um language model que decide repetidamente o que fazer em seguida, chama uma tool (buscar, executar código, editar um arquivo, chamar uma API), lê o resultado e decide de novo, até terminar ou bater num limite. Uma plataforma para agents precisa de cinco coisas em volta desse loop: um jeito de **definir e chamar tools** com segurança, **estado** para que uma execução longa sobreviva a falhas, **sandboxes** onde o código escrito pelo modelo roda, **limites** de passos, tempo e dinheiro, e **supervisão** (aprovações, logs, avaliação). O conselho mais útil das fontes é usar o design mais simples que funcione: um workflow fixo se os passos são conhecidos, um agent só se não são.

**Números principais** (como publicados)
- A Anthropic separa **workflows** (LLMs e tools "orchestrated through predefined code paths") de **agents** (LLMs que "dynamically direct their own processes and tool usage") `[CONFIRMED]`.
- Sistemas agênticos "often trade latency and cost for better task performance" `[CONFIRMED]`; agents significam "higher costs, and the potential for compounding errors" `[CONFIRMED]`.
- O ReAct superou baselines de imitação e de reinforcement learning por 34% e 10% absolutos de taxa de sucesso em dois benchmarks interativos (ALFWorld, WebShop) com um ou dois exemplos no prompt `[CONFIRMED]`.
- Na análise de erros do ReAct, 47% das falhas foram erros de raciocínio, incluindo repetir pensamentos e ações anteriores num loop `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Workflow em vez de agent livre | Previsível, mais barato, mais fácil de testar | Não consegue tratar tarefas abertas |
| Um protocolo padrão de tools (MCP) | Reutilizar tools entre hosts e modelos | Uma nova fronteira de confiança para proteger |
| Sandbox para código escrito pelo modelo | Um comando ruim não consegue ferir a plataforma | Tempo de cold start, custo de recursos, sem rede por padrão |
| Persistir o estado a cada passo | Uma queda retoma em vez de recomeçar | Trabalho de storage e de idempotency |
| Orçamentos de passos, tempo e custo | Interrompe loops descontrolados | Algumas tarefas legítimas param cedo |
| Aprovação humana para ações arriscadas | Os erros são pegos antes de importarem | Mais lento, precisa de uma boa UI de aprovação |

**Erros comuns**
- Começar com um framework complexo de agents quando uma única chamada bem escrita com retrieval resolveria.
- Tratar resultados de tools como instruções confiáveis. São dados, e podem conter texto injetado.
- Nenhuma condição de parada: um agent em loop queima tokens indefinidamente.
- Dar ao agent uma única credencial poderosa em vez da credencial estreita do usuário final.
- Descrições de tools vagas. A Anthropic relata ter gasto mais tempo otimizando tools do que o prompt geral no seu coding agent.

---

## 🧒 Non-technical explanation

Imagine um **estagiário muito capaz trabalhando num escritório com uma sala de suprimentos trancada**. Você dá a ele um objetivo. Ele pensa no que fazer, pede à sala de suprimentos uma ferramenta (uma busca, uma calculadora, um arquivo), olha o resultado e decide o próximo passo. Você define regras: ele só pode usar ferramentas aprovadas, precisa parar depois de um número de tentativas, precisa perguntar a um gerente antes de qualquer coisa irreversível, como enviar dinheiro, e anotar cada passo num diário de bordo. Qualquer coisa arriscada, como rodar um script desconhecido, acontece numa sala acolchoada, de modo que um erro não quebra nada importante.

---

## TL;DR for engineers

- **Agent** = um LLM usando tools em um loop, com base no feedback do ambiente `[CONFIRMED]` (Anthropic).
- **Prefira workflows** (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer) quando os passos são conhecíveis `[CONFIRMED]`.
- O **ReAct** intercala raciocínio e ações, o que ancora as respostas nos resultados das tools e reduz a alucinação, ao custo de loops e rigidez `[CONFIRMED]`.
- O **MCP** é um protocolo cliente-host-servidor sobre JSON-RPC para expor tools, com negociação de capacidades e uma recomendação de ter um humano no loop `[CONFIRMED]`.
- **Estado, sandbox, orçamentos, aprovações, tracing, avaliação:** as preocupações da plataforma `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** aceitar uma tarefa (chat, ticket, chamada de API) · executar um loop guiado pelo modelo com tools · fazer streaming do progresso · pausar para entrada humana · retomar após falha · registrar o trace completo.

**Não funcionais:** **segurança** (nenhuma ação além dos direitos do usuário, nenhuma fuga do sandbox) · **confiabilidade** de execuções longas · **controle de custo** · **latência** (primeira resposta logo, as tarefas podem rodar minutos ou horas) · **observabilidade** · **extensibilidade** (novas tools).

**Perguntas de esclarecimento:** tarefas abertas ou bem definidas? Quais tools, e alguma pode agir de forma irreversível (pagamentos, deletes, e-mails)? As tarefas rodam segundos ou horas? Multi-tenant? Quem aprova o quê? Como sabemos que uma execução teve sucesso?

---

## 2. Workflows versus agents `[CONFIRMED]` (Anthropic, December 2024)

O post "Building effective agents" da Anthropic agrupa os dois sob **sistemas agênticos**, mas os autores "draw an important architectural distinction" entre workflows e agents. O conselho é encontrar "the simplest solution possible, and only increasing complexity when needed", o que "might mean not building agentic systems at all", e que para muitas aplicações "optimizing single LLM calls with retrieval and in-context examples is usually enough".

**O bloco de construção** é o *augmented LLM*: um modelo com retrieval, tools e memória.

**Cinco padrões de workflow** que o post descreve:
1. **Prompt chaining:** uma sequência fixa em que cada chamada processa a saída anterior, com verificações programáticas (gates) entre os passos.
2. **Routing:** classificar a entrada e enviá-la a um próximo passo especializado, por exemplo perguntas fáceis a um modelo menor e as difíceis a um mais capaz.
3. **Parallelization:** sectioning (subtarefas independentes em paralelo) ou voting (a mesma tarefa várias vezes).
4. **Orchestrator-workers:** um modelo central quebra a tarefa dinamicamente e delega a workers, adequado a casos como mudanças de código em vários arquivos em que as subtarefas não podem ser previstas.
5. **Evaluator-optimizer:** uma chamada gera, outra avalia, em um loop, quando há critérios claros e o refinamento ajuda.

Os **agents** são para problemas abertos "where it's difficult or impossible to predict the required number of steps". Eles "are typically just LLMs using tools based on environmental feedback in a loop". A cada passo o agent deve obter a verdade do ambiente (resultados de tools, execução de código), pode pausar para feedback humano em checkpoints, e a execução muitas vezes inclui "stopping conditions (such as a maximum number of iterations)". O post recomenda "extensive testing in sandboxed environments, along with the appropriate guardrails".

**Frameworks.** O post sugere começar com chamadas diretas à API de LLM porque os frameworks "often create extra layers of abstraction that can obscure the underlying prompts and responses".

**Design de tools (a "agent-computer interface").** As definições de tools merecem tanta prompt engineering quanto os prompts. O exemplo do post: ao construir seu agent para SWE-bench, a Anthropic "spent more time optimizing our tools than the overall prompt", e descobriu que exigir caminhos de arquivo absolutos fez o modelo usar a tool "flawlessly" depois que caminhos relativos tinham causado erros. Também sugere tornar as tools difíceis de usar errado (poka-yoke), manter os formatos próximos de texto que o modelo já viu e evitar formatos que exijam contagem exata ou muito escape.

Os **coding agents** são descritos como um bom encaixe porque as soluções são verificáveis por testes automatizados e os agents podem iterar sobre os resultados dos testes, mas "human review remains crucial for ensuring solutions align with broader system requirements".

---

## 3. The agent loop: ReAct `[CONFIRMED]` (Yao et al., ICLR 2023)

O ReAct faz o modelo gerar "reasoning traces and task-specific actions in an interleaved manner": o raciocínio ajuda a "induce, track, and update action plans as well as handle exceptions", e as ações deixam-no reunir informação de fontes externas.

**Resultados.** Em question answering (HotpotQA) e verificação de fatos (Fever) com uma API da Wikipedia, o ReAct reduziu a alucinação e a propagação de erros frente ao chain-of-thought sozinho. No ALFWorld e no WebShop ele superou métodos de imitação e de reinforcement learning por 34% e 10% absolutos.

**Onde é mais fraco.** Os autores constataram que o ReAct ficou um pouco atrás do chain-of-thought no HotpotQA (27,4 contra 29,4) e à frente no Fever (60,9 contra 56,3). Num estudo manual de 50 trajetórias do HotpotQA de cada um, a alucinação foi o principal modo de falha do CoT (56% das falhas) e zero para o ReAct, enquanto a principal falha do ReAct foi de erros de raciocínio (47%), "including failing to recover from repetitive steps". Eles descrevem um padrão frequente específico do ReAct em que "the model repetitively generates the previous thoughts and actions". Buscas que não devolvem nada útil causaram 23% das falhas do ReAct.

**Consequência para o design.** Os autores recuam do ReAct para outro método depois de um número fixo de passos (7 no HotpotQA, 5 no Fever), porque mais passos não ajudavam. Inferência nossa, não do paper: esta é a mesma razão para limitar iterações e detectar repetição num loop de produção.

---

## 4. Tools as a protocol: MCP `[CONFIRMED]` (specification version 2025-06-18)

**Arquitetura.** O MCP "follows a client-host-server architecture where each host can run multiple client instances". O **host** cria e gerencia clientes, impõe a política de segurança e o consentimento e coordena a integração com o LLM. Cada **client** mantém uma sessão stateful com um servidor. Os **servers** expõem resources, tools e prompts, e podem ser processos locais ou serviços remotos. O protocolo é construído sobre JSON-RPC.

**Princípio de isolamento.** Os servers "should not be able to read the whole conversation, nor 'see into' other servers": a conversa completa fica com o host.

**Ciclo de vida.** Uma sessão começa com uma requisição `initialize` carregando a versão do protocolo, as capacidades do cliente e informações do cliente; depois que o servidor responde, o cliente envia uma notificação `initialized`. Ambos os lados passam então a usar somente as capacidades que declararam. A especificação diz que as implementações "SHOULD establish timeouts for all sent requests" e enviam uma notificação de cancelamento quando um expira.

**Tools.** Os servers que suportam tools declaram uma capacidade `tools`, listam-nas com `tools/list` e invocam-nas com `tools/call`. As tools são "model-controlled", mas por confiança e segurança "there SHOULD always be a human in the loop with the ability to deny tool invocations". Os erros de tool voltam como resultados com `isError: true`, separados dos erros de protocolo. Os clientes DEVEM tratar as anotações de tools como não confiáveis a menos que venham de servers confiáveis.

**Requisitos de segurança declarados para tools.** Os servers DEVEM validar todas as entradas das tools, implementar controles de acesso, aplicar rate limit às invocações de tools e sanitizar as saídas. Os clientes DEVERIAM pedir confirmação em operações sensíveis, mostrar as entradas das tools ao usuário antes de chamar o servidor para evitar exfiltração, validar os resultados antes de passá-los ao modelo, aplicar timeout às chamadas e registrar o uso de tools para auditoria.

---

## 4b. Sandboxing technology: Firecracker `[CONFIRMED]` (Agache et al., NSDI 2020)

A seção 5 diz que o código escrito pelo modelo precisa rodar num sandbox isolado. O exemplo mais bem documentado da tecnologia de isolamento por trás desses sandboxes é o Firecracker, o virtual machine monitor que a AWS construiu para o Lambda e o Fargate. O enquadramento do paper é a escolha que uma plataforma de agents também enfrenta: "the traditional view is that there is a choice between virtualization with strong security and high overhead, and container technologies with weaker security and minimal overhead", um trade-off que os autores chamam de inaceitável para provedores multi-tenant. O que eles construíram:
- **Design:** manter o hypervisor Linux KVM, mas trocar o QEMU por um novo virtual machine monitor mínimo, modelo de dispositivos e API para **MicroVMs**. Cerca de 50 mil linhas de Rust, "96% fewer lines than QEMU", para encolher a superfície de ataque.
- **Performance:** com uma configuração mínima de kernel convidado, "memory overhead of less than 5MB per container", boot até o código da aplicação em menos de 125 ms e criação de até 150 MicroVMs por segundo por host.
- **Defesa em profundidade ("jailer"):** o próprio Firecracker roda dentro de um sandbox restritivo: um chroot, namespaces separados de pid e rede, privilégios descartados e um perfil seccomp-bpf que faz whitelist de 24 syscalls (com filtragem de argumentos) e 30 ioctls.
- **Contraste com containers:** os containers compartilham o kernel do host e dependem de cgroups, namespaces, seccomp-bpf e chroot para o isolamento; uma fronteira de hypervisor é uma interface menor e mais forte. O paper discute os trade-offs longamente.

O que isso dá a uma resposta de entrevista: uma razão concreta para pôr código gerado não confiável numa micro-VM em vez de num container comum, e números reais de tempo de inicialização e overhead por sandbox. Não nos diz como nenhum produto de agent faz o sandbox do código, e os números são do Firecracker em hardware da AWS em 2020.

## 4c. Lessons from a production multi-agent system `[CONFIRMED]` (Anthropic, June 2025)

O post de engenharia da Anthropic sobre seu sistema de pesquisa multi-agent acrescenta detalhes de produção à seção 2. Ele usa um padrão **orchestrator-worker**: um lead agent planeja, salva seu plano na memória e dispara subagents que buscam em paralelo com suas próprias janelas de contexto e devolvem achados condensados. Pontos relatados que importam para o design de plataforma:
- **Custo:** "agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats", então a tarefa precisa valer o bastante para pagar por isso. O uso de tokens sozinho explicou 80% da variância num benchmark de navegação (BrowseComp).
- **Qualidade:** um sistema multi-agent com um modelo lead maior e subagents menores superou um único agent maior em 90,2% na avaliação interna de pesquisa deles, mais forte em tarefas breadth-first; eles notam que a maioria das tarefas de código tem menos partes paralelizáveis que a pesquisa.
- **Estado e recuperação:** "agents are stateful and errors compound"; quando ocorrem erros eles não podem simplesmente recomeçar do início, então construíram sistemas que "resume from where the agent was when the errors occurred".
- **Deploys:** como os agents podem estar em qualquer ponto do processo durante uma atualização, eles usam **rainbow deployments**, deslocando gradualmente o tráfego das versões antigas para as novas enquanto ambas rodam.
- **Debugging:** os agents são não determinísticos entre execuções, o que tornou necessário o tracing em produção.
- **Limites que eles relatam:** os lead agents executam subagents de forma síncrona, criando gargalos (o lead não consegue guiar os subagents e os subagents não conseguem se coordenar); as primeiras versões cometiam erros como disparar 50 subagents para consultas simples, então regras de escala de esforço foram embutidas nos prompts.

São experiências relatadas por uma empresa com um produto, e os números vêm de suas avaliações internas.

## 5. Reference platform `[INDUSTRY PATTERN]`

Nenhum fornecedor publica sua plataforma de agents completa, então este é o design padrão:

```
user/API ─► session API ─► orchestrator ◄─► LLM gateway (see 22)
                              │  loop: plan → tool call → observe
                              ├──► tool gateway ──► MCP servers / internal APIs (scoped credentials)
                              ├──► sandbox pool (code, shell, browser)
                              ├──► state store (messages, tool results, checkpoints)
                              ├──► approval service ──► human
                              └──► trace + budget service ──► logs, evaluation
```

- **Orchestrator:** roda o loop; cada passo é persistido antes de o próximo começar, de modo que a execução de um worker que caiu é retomada por outro worker a partir do último checkpoint. Torne as chamadas de tools idempotentes ou registre seus resultados para que um retry não repita um efeito colateral.
- **LLM gateway:** uma rota compartilhada e com rate limit para o model serving; veja [22 LLM inference serving](22-llm-inference-serving.md). Roteie passos fáceis a modelos menores.
- **Tool gateway:** um lugar para autenticar tools, aplicar permissões por usuário (use as credenciais delegadas do usuário final, não um superusuário da plataforma), impor schemas, rate limits e timeouts, e registrar as chamadas.
- **Sandbox:** o código escrito pelo modelo roda num container isolado ou VM leve sem rede ou com uma allow-list, limites de recursos, um filesystem efêmero e sem segredos da plataforma. Reduza os cold starts com um pool de sandboxes pré-aquecidos e não usados; destrua um sandbox após uma execução (ou reinicie-o totalmente) e nunca entregue um a outro tenant depois de usado.
- **Estado e memória:** guarde a conversa e os resultados das tools; resuma ou apare quando a janela de contexto enche; guarde a memória de longo prazo separadamente e trate-a como dados, não instruções.
- **Orçamentos:** limites rígidos de passos, tokens, tempo de relógio e dinheiro por execução, com uma mensagem clara quando atingidos. Detecte ações idênticas repetidas, como a análise de falhas do ReAct sugere.
- **Aprovações:** classifique as tools por risco (leitura, escrita reversível, irreversível ou cara) e exija aprovação humana para a última classe.
- **Prompt injection:** o texto devolvido por tools ou páginas web pode conter instruções. Trate-o como dado não confiável, mantenha as permissões estreitas para que uma instrução injetada não faça muito e exija aprovação para ações sensíveis.
- **Tarefas de longa duração:** rode de forma assíncrona com uma fila de jobs, faça streaming do progresso por server-sent events ou polling, permita cancelamento.
- **Observabilidade:** um trace por execução (toda chamada de modelo, chamada de tool, resultado, custo e latência), reproduzível para depuração.
- **Avaliação:** uma suíte de tarefas com verificações automáticas de sucesso (para código, os testes), executada antes de mudar modelos, prompts ou tools; acompanhe taxa de sucesso, passos e custo por tarefa.

### A coding agent on this platform

O diagrama da Anthropic de um coding agent mostra o loop de ler a tarefa, editar arquivos, executar código e testes e usar os resultados como feedback. Na plataforma: o repositório é feito checkout num sandbox, as tools são `read_file`, `edit_file`, `run_command`, `search`, os resultados dos testes são a verdade, um branch ou patch é a saída, e um humano o revisa antes do merge. O conjunto de tools e a sua documentação importam tanto quanto o prompt.

---

## 6. Failure scenarios

- **Loop infinito ou repetitivo.** O limite de passos e um detector de repetição o interrompem `[CONFIRMED]` quanto à existência da falha (ReAct); as mitigações são `[INDUSTRY PATTERN]`.
- **O worker cai no meio da execução.** Retome do último checkpoint; tools idempotentes evitam efeitos colaterais duplicados `[INDUSTRY PATTERN]`.
- **Uma tool está lenta ou trava.** Aplique timeout e informe ao modelo um resultado de erro (o MCP recomenda timeouts e cancelamento) `[CONFIRMED]` quanto à orientação do protocolo.
- **Prompt injection por um resultado de tool.** Permissões estreitas, aprovações e validação das saídas limitam o dano `[INDUSTRY PATTERN]`; o MCP diz que os clientes devem validar os resultados das tools `[CONFIRMED]`.
- **O modelo propõe uma ação destrutiva.** Gate de aprovação e modo dry-run `[INDUSTRY PATTERN]`.
- **Fuga do sandbox ou abuso de recursos.** Isolamento, limites, sem segredos, vida curta `[INDUSTRY PATTERN]`.
- **Estouro de custo.** Orçamentos e alertas `[INDUSTRY PATTERN]`.

---

## 7. Cost reasoning (illustrative)

- Os tokens por execução crescem com os passos porque cada passo normalmente reenvia o histórico crescente. Dez passos com um contexto de 20.000 tokens no final poderiam ler da ordem de 100.000 tokens de entrada no total, antes do prompt caching. Esses números são premissas para mostrar o formato, não medições.
- Custo por tarefa ≈ tokens de entrada × preço de entrada + tokens de saída × preço de saída + custos de tools e sandbox. Os preços variam, então declare-os como premissas numa entrevista.
- Um dado publicado sobre o multiplicador: a Anthropic relata agents usando cerca de 4 vezes e sistemas multi-agent cerca de 15 vezes os tokens de uma interação de chat (seção 4c).
- Alavancas: menos passos (tools melhores), modelos menores para passos fáceis, prompt caching do prefixo estável, resumir turnos antigos, parar cedo.

---

## ⚠️ Reviewer notes

1. **O post da Anthropic é orientação da experiência de um fornecedor,** não um benchmark. Não contém um design de plataforma medido.
2. **Os números do ReAct são de modelos da era de 2022** (o paper usa o PaLM) e de benchmarks específicos; não os leia como desempenho dos modelos atuais.
3. **O MCP é uma especificação viva.** Lemos a versão 2025-06-18; versões posteriores podem diferir.
4. **As peças da plataforma (estado, sandbox, aprovações, orçamentos, tracing) são prática do setor,** não afirmações com fonte. A política de sandbox (sem rede, sem segredos, vida curta) é raciocínio nosso; o Firecracker (seção 4b) documenta a tecnologia de isolamento mas não a política específica para agents.
5. **Not read:** outros papers de agents (Reflexion, Toolformer, SWE-agent), benchmarks de avaliação de agents além de menções, documentação de SDKs de agents de fornecedores, documentação do gVisor e de isolamento de containers.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes citadas. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **segurança**, **confiabilidade** de execuções longas, **controle de custo**, **observabilidade**, **extensibilidade**.
- **Estilo (Ch 13):** **service-based guiado por orquestração:** um orquestrador central coordenando serviços de tools, modelo e sandbox.
- **Quanta (Ch 7):** sandboxes e servidores de tools são quanta separados, com suas próprias fronteiras de falha e segurança; o orquestrador é o coordenador stateful.
- **Trade-off (First Law, Ch 1):** **autonomia vs controle.** Mais liberdade para o modelo trata trabalho aberto e aumenta custo, risco e imprevisibilidade.
- **Esboço de ADR (Ch 19):** *"Vamos implementar formatos de tarefa conhecidos como workflows e usar um agent em loop apenas para tarefas abertas, atrás de orçamentos de passos, tempo e custo e de aprovações para ações irreversíveis. Aceitamos menos flexibilidade em troca de previsibilidade."*
- Em linguagem simples: um estagiário com um manual de regras, uma sala acolchoada e um diário de bordo.

---

## Interview questions to practice

1. Projete uma plataforma que roda agents de IA usando tools. Qual é o loop central?
2. Quando você usaria um workflow fixo em vez de um agent?
3. Como fazer um agent de longa duração sobreviver a falhas?
4. Como executar código que um modelo escreveu?
5. Como impedir um agent de entrar em loop ou gastar demais?
6. Como impedir que um resultado de tool sequestre o agent (prompt injection)?
7. Como avaliar um agent, por exemplo um coding agent?
8. O que é o MCP, e quais são as preocupações de segurança de conectar tools de terceiros?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: tipos de tarefa, tools e seu risco, duração, tenants, necessidades de aprovação.
2. Estimar: execuções por dia, passos por execução, tokens por passo, concorrência de sandboxes.
3. API: criar execução, fazer streaming de eventos, aprovar ou rejeitar uma ação, cancelar, buscar o trace.
4. Design: session API, orquestrador, LLM gateway, tool gateway, pool de sandboxes, state store, serviço de aprovação, tracing.
5. Deep dive: o loop e o checkpointing; sandboxing; permissões e aprovações.
6. Falhas e escala: queda de worker, loops, tools lentas, injection, custo; escalar sandboxes.

**Se crescer 10×**
- Capacidade de sandbox e cold starts: pools de sandboxes pré-aquecidos e não usados e snapshots de uma imagem base limpa, nunca de um sandbox usado.
- Custo de modelo: roteie passos a modelos menores, faça cache de prefixos, apare o contexto.
- Volume de observabilidade: amostre traces, guarde o detalhe completo para falhas.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Como um agent de longa duração sobrevive a uma queda?</summary>

Persista a conversa, os resultados das tools e o número do passo depois de cada passo. Um novo worker carrega o último checkpoint e continua. As chamadas de tools são idempotentes ou seus resultados são armazenados, de modo que um retry devolve o resultado registrado em vez de repetir um efeito colateral.

</details>

<details><summary>Como executar com segurança código escrito por um modelo?</summary>

Num sandbox isolado e de vida curta, sem rede ou com uma allow-list, com CPU, memória e tempo limitados, um filesystem efêmero e sem credenciais da plataforma. O sandbox devolve apenas a saída; qualquer coisa que saia dele passa pelo tool gateway.

</details>

<details><summary>Como tratar a prompt injection?</summary>

Presuma que o conteúdo de tools e da web é hostil. Mantenha as permissões do agent estreitas para que uma instrução injetada tenha pouco poder, valide os resultados das tools, separe dados de instruções no prompt e ponha ações irreversíveis atrás de aprovação humana.

</details>

## 📚 Further reading

- As três fontes listadas em Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) para noções básicas de tool use.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [22 LLM inference serving](22-llm-inference-serving.md), [23 RAG knowledge assistant](23-rag-knowledge-assistant.md), [10 Notification system](10-notification-system.md) e [17 Payment system](17-payment-system.md) para idempotency e retries.

## Sources and provenance

> **Kind:** reference design com partes reais. A orientação sobre workflows e agents, o protocolo MCP e o método ReAct são publicados. Como qualquer fornecedor roda uma plataforma de agents não é, então a plataforma da seção 5 é o design padrão `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Schluntz and Zhang, Anthropic, [*Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents) (19 de dezembro de 2024; lido por uma cópia do Internet Archive) · Model Context Protocol, especificação versão 2025-06-18: [Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture), [Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) e [Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) · Yao et al., [*ReAct: Synergizing Reasoning and Acting in Language Models*](https://arxiv.org/pdf/2210.03629) (ICLR 2023; texto do PDF extraído localmente) · Agache et al., [*Firecracker: Lightweight Virtualization for Serverless Applications*](https://www.usenix.org/system/files/nsdi20-paper-agache.pdf) (NSDI 2020; texto do PDF extraído localmente) · Anthropic, [*How we built our multi-agent research system*](https://www.anthropic.com/engineering/multi-agent-research-system) (junho de 2025; lido por uma cópia do Internet Archive).
> **Dated material:** orientação de dezembro de 2024, uma versão de protocolo de junho de 2025 e um paper de 2022. Esta área muda rápido.
> **Not read:** outras pesquisas e benchmarks de agents, SDKs de agents de fornecedores, documentação do gVisor e de isolamento de containers.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source in full. Quotations are confirmed by `npm run verify`.*
- Verified in Anthropic's post: workflow and agent definitions, simplicity advice, the five workflow patterns, agent loop description, stopping conditions, sandbox and guardrail recommendation, framework caution, tool-design advice including absolute file paths and time spent on tools, coding agent verification by tests and human review.
- Verified in the MCP specification (2025-06-18): client-host-server architecture, host and client responsibilities, isolation principle, initialize and initialized handshake, timeout recommendation, tools capability and `tools/list`, `tools/call`, human-in-the-loop recommendation, `isError`, untrusted annotations, server and client security requirements.
- Verified in the ReAct paper: abstract claims, 34% and 10% gains, HotpotQA and Fever comparisons (27.4 vs 29.4, 60.9 vs 56.3), Table 2 failure shares (47%, 23%, 56%), repetition pattern, back-off at 7 and 5 steps.
- Verified in the Firecracker paper: the isolation trade-off statement, KVM with a replacement minimal VMM, about 50k lines of Rust (96% fewer than QEMU), under 5 MB memory overhead, boot under 125 ms, 150 MicroVMs per second per host, the jailer's chroot, namespaces, privilege drop and seccomp profile (24 syscalls, 30 ioctls).
- Verified in Anthropic's multi-agent post: the 4 times and 15 times token figures, 80% variance explained by token usage, 90.2% internal evaluation gain, resume-from-error and rainbow-deployment statements, synchronous-subagent limitation.
- Labelled industry pattern, not sourced: orchestrator state and checkpointing, tool gateway and credentials, sandbox design, budgets, approvals, injection defences, async execution, observability, evaluation harness, cost arithmetic.
- Not claimed: how any specific vendor's agent product is built.
