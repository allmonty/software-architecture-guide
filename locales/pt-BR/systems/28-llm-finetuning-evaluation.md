# 28 — LLM Fine-tuning, Evaluation and Deployment Pipeline

*Um reference design construído sobre métodos publicados (LoRA, InstructGPT, DPO, S-LoRA, LLM-as-a-judge) e uma receita pública detalhada (o pós-treinamento do Llama 3). Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Você tem um modelo que é bom, mas não bom o bastante: ele erra o seu domínio, ignora o seu formato ou diz coisas que você não pode publicar. Melhorá-lo é um loop, não um trabalho único: **curar dados**, **treinar** (full fine-tuning, adapters LoRA ou preference tuning), **avaliar contra um gate** (qualidade, regressões, segurança, latência, custo), **liberar gradualmente** e **observar a produção** para que as falhas virem a próxima rodada de dados. Tente primeiro as opções mais baratas (prompts melhores, retrieval); faça fine-tuning quando o comportamento, o estilo ou uma habilidade restrita precisar mudar. A falha mais comum é um modelo que melhora na métrica-alvo e, em silêncio, piora em outro lugar.

**Números principais** (como publicados, nos testes dos autores)
- O LoRA reduziu os parâmetros treináveis em 10.000 vezes e a memória de GPU de treinamento em 3 vezes comparado ao full fine-tuning do GPT-3 175B com Adam, com qualidade equivalente ou melhor `[CONFIRMED]`; o checkpoint encolheu de 350 GB para 35 MB na configuração do paper `[CONFIRMED]`.
- InstructGPT: as saídas de um modelo de 1,3B ajustado com feedback humano foram preferidas às do GPT-3 de 175B, com 100 vezes menos parâmetros `[CONFIRMED]`.
- O pós-treinamento do Llama 3 usou seis rodadas de supervised fine-tuning, rejection sampling e DPO `[CONFIRMED]`; o DPO "required less compute for large-scale models and performed better" que o PPO nos testes deles `[CONFIRMED]`.
- O S-LoRA serviu milhares de adapters LoRA em uma ou mais GPUs, com até 4 vezes o throughput do vLLM com suporte ingênuo a LoRA ao servir um pequeno número de adapters (o baseline não escala para muitos) e até 30 vezes o do HuggingFace PEFT, ao mesmo tempo em que suportava um número significativamente maior de adapters `[CONFIRMED]` (benchmarks dos autores, em modelos Llama-7B e 13B em GPUs A10G e A100).
- Juízes LLM fortes coincidiram com as preferências humanas com mais de 80% de concordância, o mesmo nível da concordância entre humanos `[CONFIRMED]` (paper do MT-Bench).

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Adapters LoRA em vez de full fine-tuning | Checkpoints minúsculos, treinamento barato, muitas variantes | Pode não igualar o full fine-tuning para grandes mudanças de comportamento |
| Preference tuning com DPO em vez de RLHF baseado em PPO | Mais simples, sem amostragem durante o ajuste | Precisa de bons pares de preferência; a qualidade dos dados domina |
| Condicionar todo release a uma suíte de avaliação | Pegar regressões antes dos usuários | Construir e manter a suíte dá trabalho de verdade |
| Juiz LLM para qualidade aberta | Escala onde humanos não escalam | Os juízes têm vieses; calibre com humanos |
| Rollout canary com rollback rápido | Limita o blast radius | Exige roteamento e monitoramento instalados |

**Erros comuns**
- Fazer fine-tuning para injetar fatos. O retrieval (veja [23 RAG knowledge assistant](23-rag-knowledge-assistant.md)) atualiza o conhecimento; o fine-tuning molda o comportamento.
- Medir apenas a tarefa-alvo. O InstructGPT relatou regressões em benchmarks públicos (um "alignment tax") que precisaram de uma correção específica.
- Avaliar em dados que vazaram para o treinamento (contaminação).
- Confiar num juiz LLM sem checar seus vieses.
- Nenhum plano de rollback para um release de modelo.

---

## 🧒 Non-technical explanation

Imagine **treinar um funcionário novo e talentoso**. Primeiro você confere se um briefing mais claro ou uma pasta de referência bastaria (prompting, retrieval). Se ele ainda precisa mudar a forma de trabalhar, você lhe dá exemplos resolvidos, depois pede que produza várias respostas e diz quais você prefere. Depois de cada rodada você aplica um teste padrão, incluindo os testes antigos, para perceber se corrigir uma fraqueza criou outra. Só então ele encontra clientes, primeiro poucos, com um supervisor que pode tirá-lo da mesa instantaneamente. Tudo o que dá errado com clientes reais vai para a próxima rodada de treinamento.

---

## TL;DR for engineers

- **Ordem das tentativas:** prompt, depois retrieval, depois fine-tuning `[INDUSTRY PATTERN]`; a Anthropic observa que "optimizing single LLM calls with retrieval and in-context examples is usually enough" para muitas aplicações `[CONFIRMED]`.
- O **LoRA** congela o modelo e treina pequenas matrizes de baixo rank, de modo que os adapters são minúsculos e trocáveis `[CONFIRMED]`.
- **Receita de alinhamento:** demonstrações supervisionadas, depois dados de preferência, depois uma etapa de otimização de preferência (RLHF com PPO no InstructGPT; DPO no Llama 3) `[CONFIRMED]`.
- A **qualidade dos dados** é a principal alavanca e um esforço de engenharia pesado no Llama 3 (limpeza, poda, pontuação, deduplicação) `[CONFIRMED]`.
- A **avaliação** combina benchmarks, preferência humana ou de juiz LLM, métricas de segurança (taxa de violação e taxa de recusa falsa) e verificações de contaminação `[CONFIRMED]` como praticado nas fontes.
- **Servir muitos adapters** é um problema de gerenciamento de memória resolvido pelo S-LoRA `[CONFIRMED]`.
- **Gates de release, canary, rollback, loop de feedback:** a plataforma em volta do treinamento `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** ingerir e curar dados de treinamento · executar jobs de fine-tuning (completo, adapter, preference tuning) · avaliar candidatos automaticamente · registrar versões · implantar gradualmente e fazer rollback · coletar feedback de produção para a próxima rodada.

**Não funcionais:** **qualidade** (métrica-alvo para cima) · **sem regressões** (outras capacidades, segurança) · **reprodutibilidade** (dados e configuração versionados) · **custo** (horas de GPU, rotulagem) · **velocidade de iteração** · **segurança e conformidade** (permissão dos dados de treinamento, privacidade) · **custo de serving** de muitas variantes.

**Perguntas de esclarecimento:** o que está errado com o modelo atual, e é conhecimento, comportamento ou formato? Quantos dados rotulados existem, e quem pode rotular? Quantas variantes (por cliente, por tarefa)? O que nunca pode regredir? Com que frequência liberamos? Quanto custa um release ruim?

---

## 2. Should you fine-tune? `[INDUSTRY PATTERN]`, with one sourced anchor

Tente nesta ordem e pare quando a métrica for atingida: um prompt e exemplos melhores, depois retrieval, depois fine-tuning. A orientação da Anthropic diz "optimizing single LLM calls with retrieval and in-context examples is usually enough" para muitas aplicações e recomenda acrescentar complexidade só quando ela "demonstrably improves outcomes" `[CONFIRMED]` (veja [25 AI agent platform](25-ai-agent-platform.md)). Faça fine-tuning quando precisar de estilo ou formato consistente, de uma habilidade restrita que o modelo base não tem, de menor custo usando um modelo menor ajustado, ou de um comportamento que prompts não conseguem impor. Não faça fine-tuning para adicionar fatos que mudam; use retrieval.

---

## 3. Methods

### 3.1 LoRA: cheap, swappable adapters `[CONFIRMED]` (Hu et al.)

O full fine-tuning "retrains all model parameters", e "deploying independent instances of fine-tuned models, each with 175B parameters, is prohibitively expensive". O **LoRA** congela os pesos do modelo pré-treinado e injeta pequenas matrizes treináveis de decomposição de rank em cada camada do Transformer. A atualização de uma matriz de pesos W0 é representada como W0 + BA com um rank r pequeno.

Efeitos relatados no GPT-3 175B: parâmetros treináveis reduzidos em 10.000 vezes e requisito de memória de GPU reduzido em 3 vezes; qualidade equivalente ou melhor que o fine-tuning nos modelos que testaram; e, ao contrário de adapters inseridos como camadas extras, "no additional inference latency", porque o BA pode ser mesclado em W0. A VRAM de treinamento caiu de 1,2 TB para 350 GB, e com r = 4 nas projeções de query e value o checkpoint encolheu de 350 GB para 35 MB. Trocar de tarefa significa trocar as pequenas matrizes, "a quick operation with very little memory overhead".

**O que isso significa para o design:** um modelo base mais muitos adapters pequenos (por cliente ou tarefa), versionados como código.

### 3.1b QLoRA: fine-tuning a large model on one GPU `[CONFIRMED]` (Dettmers et al., 2023)

O QLoRA estende o LoRA para cortar ainda mais a memória, de modo que modelos grandes possam ser ajustados em hardware modesto. O abstract diz que ele é eficiente o bastante "to finetune a 65B parameter model on a single 48GB GPU while preserving full 16-bit finetuning task performance". Ele "backpropagates gradients through a frozen, 4-bit quantized pretrained language model into Low Rank Adapters". Três economias de memória: **4-bit NormalFloat (NF4)**, um tipo de dado que os autores chamam de teoricamente ótimo em informação para pesos com distribuição normal; **Double Quantization**, que quantiza as constantes de quantização; e **Paged Optimizers** para gerenciar picos de memória. A família de modelos Guanaco deles chegou a 99,3% do desempenho do ChatGPT no benchmark Vicuna com 24 horas de fine-tuning numa GPU (afirmação dos autores nesse benchmark e período).

Duas constatações importam para a seção de avaliação abaixo: o fine-tuning num dataset pequeno e de alta qualidade deu resultados de ponta mesmo com modelos menores, e os autores constataram que as avaliações do GPT-4 são "a cheap and reasonable alternative to human evaluation" enquanto "current chatbot benchmarks are not trustworthy to accurately evaluate the performance levels of chatbots". Para o design de sistema: adapters no estilo LoRA podem ficar sobre uma base quantizada, reduzindo a GPU necessária para o treinamento; se a quantização é aceitável para a qualidade do serving é uma questão de avaliação separada que o paper não resolve.

### 3.2 Aligning with human feedback: InstructGPT `[CONFIRMED]` (Ouyang et al., 2022)

A receita: coletar prompts escritos por rotuladores e da API, coletar **demonstrações** humanas e fazer fine-tuning com aprendizado supervisionado; coletar **rankings** de saídas do modelo, treinar um reward model; depois fazer fine-tuning com reinforcement learning (PPO) contra o reward model. O paper relata a contratação de uma equipe de 40 contratados; os datasets foram cerca de 13 mil prompts para o supervised fine-tuning, 33 mil para o reward model e 31 mil para o PPO.

Resultados: as saídas do InstructGPT de 1,3B foram preferidas às do GPT-3 de 175B apesar de "100x fewer parameters"; o InstructGPT de 175B foi preferido às saídas do GPT-3 de 175B em 85 ± 3% das vezes; em tarefas de domínio fechado ele inventou informações cerca de metade das vezes (21% contra 41%); produziu cerca de 25% menos saídas tóxicas quando instruído a ser respeitoso; não melhorou de forma significativa em dois datasets de viés.

**O alignment tax.** O RLHF causou regressões de desempenho em datasets públicos (SQuAD, DROP, HellaSwag, WMT 2015 francês para inglês). Misturar atualizações que aumentam a verossimilhança da distribuição de pré-treinamento (PPO-ptx) as reduziu muito "without compromising labeler preference scores".

**As preferências de quem.** Os autores afirmam que o procedimento alinha o modelo às preferências declaradas de um grupo específico (principalmente rotuladores e pesquisadores), "rather than any broader notion of 'human values'".

### 3.3 DPO: preference tuning without a reward-model loop `[CONFIRMED]` (Rafailov et al., 2023)

O RLHF é descrito como "a complex and often unstable procedure". O DPO usa uma parametrização que permite resolver o problema padrão "with only a simple classification loss", sem amostrar do modelo durante o fine-tuning e com pouco ajuste de hiperparâmetros. Os autores relatam que ele iguala ou supera o RLHF baseado em PPO em controle de sentimento, sumarização e diálogo de um turno, sendo mais simples.

### 3.4 A full public recipe: Llama 3 post-training `[CONFIRMED]` (Meta, 2024)

O Llama 3 é alinhado com "several rounds of post-training", cada rodada sendo supervised fine-tuning (SFT) seguido de DPO em exemplos coletados por anotação humana ou gerados sinteticamente; o paper aplica "six rounds". A espinha dorsal é um reward model treinado em dados de preferência humana e o language model. Elementos principais:
- **Rejection sampling:** para cada prompt, amostre K saídas (tipicamente 10 a 30) do modelo mais recente e use o reward model para escolher a melhor; essas viram dados de treinamento. O PagedAttention (veja [22 LLM inference serving](22-llm-inference-serving.md)) deu mais de 2 vezes de throughput nesta etapa.
- **Detalhes do DPO:** principalmente os dados de preferência mais novos, para que os dados correspondam à política atual; eles tentaram PPO mas o DPO precisou de menos computação e se saiu melhor, especialmente em benchmarks de seguir instruções; learning rate de 10⁻⁵ e β de 0,1; tokens de formatação mascarados na loss por estabilidade.
- **Model averaging:** média de modelos de experimentos com dados ou hiperparâmetros diferentes em cada estágio de reward model, SFT ou DPO.
- **Limpeza de dados e controle de qualidade** porque a maior parte dos dados é gerada por modelo: remoção baseada em regras de padrões como emojis em excesso ou frases excessivamente pedintes de desculpa; classificação de tópicos; pontuação de qualidade usando sinais tanto do reward model quanto baseados no Llama (exemplos marcados como de alta qualidade por qualquer um dos dois foram mantidos, já que os dois discordavam com frequência); pontuação de dificuldade; deduplicação semântica.
- **Segurança:** uma taxa de violação medida em prompts adversariais e uma **taxa de recusa falsa** medida em prompts limítrofes, otimizadas juntas, com red teaming e um modelo Llama Guard separado para segurança de entrada e saída.

Esta é uma receita de uma grande organização; as fontes não dizem quais partes importam mais para um time menor.

---

## 4. Evaluation `[CONFIRMED]` where noted, otherwise `[INDUSTRY PATTERN]`

- **Por que benchmarks tradicionais não bastam.** O paper do MT-Bench observa que os modelos alinhados são muito preferidos pelos usuários enquanto benchmarks como MMLU e HELM "cannot effectively tell the difference" entre modelos alinhados e base.
- **LLM-as-a-judge.** Usar modelos fortes para julgar respostas a perguntas abertas chegou a "over 80% agreement" com as preferências humanas, "the same level of agreement between humans". O paper também nomeia os limites: **vieses de posição, verbosidade e autoaprimoramento**, e capacidade de raciocínio limitada, com mitigações propostas. Calibre qualquer juiz contra rótulos humanos na sua própria tarefa.
- **Contaminação.** O Llama 3 inclui uma análise de quanto os scores de benchmark podem ser influenciados por dados de avaliação que aparecem no corpus de pré-treinamento. Mantenha seus conjuntos de avaliação fora dos dados de treinamento e verifique sobreposições.
- **Par de métricas de segurança.** Acompanhe violações e recusas falsas juntas, já que reduzir uma tende a aumentar a outra `[CONFIRMED]` (o Llama 3 otimiza as duas).
- **Suíte de regressão** `[INDUSTRY PATTERN]`: um conjunto fixo de tarefas cobrindo o que o modelo fazia bem antes (capacidade geral, seguir formato, bugs corrigidos anteriormente), mais latência e custo por requisição. Um gate de release compara o candidato com o modelo de produção atual, não com um número isolado.
- **Revisão humana** `[INDUSTRY PATTERN]`: amostras de discordâncias e dos casos de pior pontuação.

---

## 5. Serving many fine-tuned variants: S-LoRA `[CONFIRMED]` (Sheng et al., 2023)

Com adapters, um deploy pode servir muitos modelos customizados, mas designs ingênuos carregam cada adapter na memória da GPU. O **S-LoRA** "stores all adapters in the main memory and fetches the adapters used by the currently running queries to the GPU memory". O **Unified Paging** usa um único pool de memória para pesos de adapters de ranks diferentes e tensores de KV-cache de comprimentos variados, reduzindo a fragmentação. Ele acrescenta uma estratégia de tensor parallelism e kernels customizados para agrupar requisições que usam adapters diferentes. Resultados relatados: milhares de adapters servidos numa única GPU ou em várias, até 4 vezes o throughput do vLLM com suporte ingênuo a LoRA ao servir um pequeno número de adapters, até 30 vezes o do HuggingFace PEFT e várias ordens de magnitude mais adapters servidos. O número de 4 vezes vale para contagens pequenas de adapters, porque o baseline não consegue escalar para um número grande; os benchmarks do paper usam modelos Llama-7B e 13B em GPUs A10G e A100.

---

## 6. The platform `[INDUSTRY PATTERN]`

```
production feedback ─► data pipeline (filter, dedup, quality score, version) ◄─ annotators
                              │
        pretrained model ─► training jobs (SFT · LoRA · DPO · rejection sampling) on a GPU cluster
                              │ candidate model or adapter
                              ▼
                       model registry ─► evaluation gate ──► pass? ─► canary router ─► serving (base + adapters)
                         (versioned)      benchmarks · regression · judge · safety · cost    │
                                                                                monitoring ◄─┘ ─► rollback / next round
```

- **Pipeline de dados:** datasets versionados com lineage, verificações de permissão e PII, deduplicação e uma pontuação de qualidade; dados de avaliação reservados mantidos separados.
- **Jobs de treinamento:** configurações reproduzíveis, checkpointing e a infraestrutura coberta em [27 LLM training infrastructure](27-llm-training-infrastructure.md).
- **Registry:** cada modelo e adapter com sua versão de dados, configuração, métricas e estado de aprovação.
- **Gate de avaliação:** automático; bloqueia o release se qualquer métrica protegida regredir além de um limiar ou se a segurança piorar.
- **Rollout:** tráfego em shadow (o candidato roda, a resposta não é mostrada), depois uma pequena porcentagem canary, depois ampliação; rollback automático por taxa de erro, latência, feedback do usuário ou sinal de segurança.
- **Monitoramento e feedback:** acompanhe proxies de qualidade (thumbs, edições, escalações), drift e custo; amostre as falhas para os dados da próxima rodada.
- **Serving:** adapters por tenant ou tarefa sobre modelos base compartilhados, como no S-LoRA; veja [22 LLM inference serving](22-llm-inference-serving.md).
- **Governança:** registre quem aprovou um release e quais dados ele usou.

---

## 7. Failure scenarios

- **Uma regressão passa despercebida.** O candidato é melhor na métrica-alvo e pior em outros lugares. A suíte de regressão e um gate contra o modelo de produção a pegam `[CONFIRMED]` quanto à ocorrência dessas regressões (o alignment tax do InstructGPT); o gate é `[INDUSTRY PATTERN]`.
- **Contaminação da avaliação.** Os scores parecem ótimos porque dados de teste estavam nos dados de treinamento; verifique a sobreposição `[CONFIRMED]` como análise praticada (Llama 3).
- **Viés do juiz.** Um modelo juiz prefere respostas mais longas ou listadas primeiro; aleatorize a ordem, controle o tamanho, confira contra humanos `[CONFIRMED]` (MT-Bench).
- **Dados ruins envenenam o modelo.** Limpeza, poda e deduplicação, como no Llama 3 `[CONFIRMED]`.
- **O canary mostra degradação ao vivo.** Faça rollback para a versão anterior `[INDUSTRY PATTERN]`.
- **Recusa excessiva ou saídas inseguras.** Acompanhe as taxas de violação e de recusa falsa `[CONFIRMED]`.
- **Proliferação de adapters.** Milhares de adapters exigem gerenciamento de ciclo de vida, scheduling ciente de memória e limpeza `[INDUSTRY PATTERN]`; o S-LoRA trata do lado do serving `[CONFIRMED]`.

---

## 8. Cost reasoning (illustrative)

- A **memória do full fine-tuning** é dominada pelo estado do otimizador; a redução de 3 vezes relatada do LoRA e os checkpoints de 35 MB mudam a economia de muitas variantes. Seus números dependem do tamanho do modelo e do rank.
- O custo de **rotulagem** ≈ exemplos × minutos × valor por hora; os datasets do InstructGPT eram da ordem de dezenas de milhares de prompts, mas as receitas modernas misturam dados humanos e sintéticos.
- O custo de **avaliação** por candidato ≈ tamanho da suíte × custo por chamada, mais chamadas de juiz. Uma suíte rodada em cada candidato deve ser barata o bastante para rodar com frequência.
- **Servir** muitos adapters sobre uma base compartilhada é muito mais barato que um deploy por variante, segundo os resultados do S-LoRA.

---

## ⚠️ Reviewer notes

1. **Os resultados são de modelos e tarefas específicos.** Os números do LoRA são de modelos da era do GPT-3 e menores, os do InstructGPT de modelos de 2022 e das preferências de seus rotuladores, e os do Llama 3 dos dados e da escala da Meta.
2. **DPO versus PPO não se resolve com um único resultado.** O Llama 3 relata o DPO melhor para eles; o paper do DPO relata paridade ou melhor nas suas tarefas. Não afirmamos que o DPO sempre vence.
3. **A concordância do juiz LLM foi medida em dados do MT-Bench e do Chatbot Arena,** com o GPT-4 como juiz. Ela não precisa valer para a sua tarefa ou o seu juiz.
4. **O pipeline de release (gate, shadow, canary, rollback) é prática do setor,** não tem fonte.
5. **Not read:** outras variantes de adapters (o QLoRA é coberto na seção 3.1b), datasets de segurança do RLHF em detalhe, plataformas de avaliação, orientações de licenciamento de dados e a documentação de serviços de fine-tuning de fornecedores.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes citadas. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **garantia de qualidade** (sem regressões), **reprodutibilidade**, **agilidade** (iteração rápida), **segurança**, **eficiência de custo**.
- **Estilo (Ch 13):** um **pipeline** (dados → treinamento → avaliação → deploy) fechado em loop pelo feedback de produção.
- **Quanta (Ch 7):** treinamento e serving são quanta independentes unidos pelo registry; o gate de avaliação é o contrato entre eles.
- **Trade-off (First Law, Ch 1):** **velocidade de iteração vs segurança do release.** Mais avaliação e rampas mais lentas reduzem o risco e retardam a melhoria.
- **Esboço de ADR (Ch 19):** *"Vamos liberar modelos e adapters apenas por um gate de avaliação automático que compara com o modelo de produção, depois um canary com rollback automático. Aceitamos releases mais lentos em troca de pegar regressões antes dos usuários."*
- Em linguagem simples: treine, teste contra os testes antigos, libere para poucos, observe, repita.

---

## Interview questions to practice

1. Nosso chatbot erra o nosso domínio e ignora o nosso formato. Como você o melhoraria?
2. Quando fazer fine-tuning em vez de usar retrieval ou prompts melhores?
3. O que é o LoRA, e por que importa para servir muitos clientes?
4. Como impedir que um modelo ajustado regrida em outras tarefas?
5. Como avaliar saída aberta? Quais são as armadilhas de um juiz LLM?
6. Como você liberaria uma nova versão de modelo com segurança?
7. Como construiria o pipeline de dados, e o que dá errado com dados ruins?
8. Como serviria mil variantes específicas de clientes?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: o que está falhando, dados e rotuladores disponíveis, número de variantes, comportamentos protegidos, cadência de release.
2. Decidir a abordagem: prompt, retrieval, fine-tuning com adapters, preference tuning; justifique.
3. Projetar o pipeline: curadoria de dados, jobs de treinamento, registry, gate de avaliação, rollout, monitoramento.
4. Deep dive: a suíte de avaliação (alvo, regressão, segurança, custo) e os limites do juiz.
5. Serving: base compartilhada com adapters, gerenciamento de memória.
6. Falhas e escala: regressão, contaminação, dados ruins, rollback, crescimento de adapters.

**Se crescer 10×**
- Variantes: ciclo de vida de adapters, serving ciente de memória, avaliação automatizada por tenant.
- Dados: a pontuação de qualidade e a deduplicação viram o gargalo; invista em ferramentas e seleção ativa.
- Avaliação: mantenha a suíte rápida, faça amostragem e use juízes com calibração humana.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Como evitar regressões?</summary>

Mantenha uma suíte de regressão do que o modelo fazia bem antes, rode-a em cada candidato e condicione o release a não ficar pior que o modelo de produção além de uma tolerância. Misture dados gerais durante o ajuste, mantenha a learning rate modesta e acompanhe juntas as taxas de segurança e de recusa.

</details>

<details><summary>Quais são as armadilhas de um juiz LLM?</summary>

Vieses de posição, verbosidade e autoaprimoramento, e raciocínio fraco em perguntas difíceis. Aleatorize a ordem das respostas, controle o tamanho, use um juiz de uma família diferente da do modelo julgado e calibre contra rótulos humanos na sua tarefa.

</details>

<details><summary>Como liberar com segurança?</summary>

Registre o modelo, passe pelo gate, rode em shadow, depois um pequeno canary, amplie observando sinais de qualidade, latência, custo e segurança, e mantenha a versão anterior aquecida para um rollback instantâneo.

</details>

## 📚 Further reading

- Os papers e o relatório listados em Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) para noções básicas de treinamento e tokens.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [22 LLM inference serving](22-llm-inference-serving.md), [23 RAG knowledge assistant](23-rag-knowledge-assistant.md), [25 AI agent platform](25-ai-agent-platform.md) e [27 LLM training infrastructure](27-llm-training-infrastructure.md).

## Sources and provenance

> **Kind:** reference design com partes reais. Os métodos são publicados; como qualquer empresa roda seu próprio pipeline de melhoria não é, exceto pela receita do Llama 3. O pipeline de release da seção 6 é o design padrão `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (texto dos PDFs extraído localmente):** Hu et al., [*LoRA: Low-Rank Adaptation of Large Language Models*](https://arxiv.org/pdf/2106.09685) (2021) · Ouyang et al., [*Training language models to follow instructions with human feedback*](https://arxiv.org/pdf/2203.02155) (2022) · Rafailov et al., [*Direct Preference Optimization*](https://arxiv.org/pdf/2305.18290) (2023) · Dettmers et al., [*QLoRA: Efficient Finetuning of Quantized LLMs*](https://arxiv.org/pdf/2305.14314) (2023) · Sheng et al., [*S-LoRA: Serving Thousands of Concurrent LoRA Adapters*](https://arxiv.org/pdf/2311.03285) (2023) · Zheng et al., [*Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*](https://arxiv.org/pdf/2306.05685) (2023) · Llama Team, Meta, [*The Llama 3 Herd of Models*](https://arxiv.org/pdf/2407.21783) (2024; Seção 4 pós-treinamento, partes das Seções 5 e 6) · e, para a âncora da seção 2, Anthropic, [*Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents) (2024).
> **Dated material:** papers de 2021–2024; receitas e boas práticas mudam rápido.
> **Not read:** serviços de fine-tuning de fornecedores, outros frameworks de avaliação, as seções do Llama 3 sobre dados de pré-treinamento além do que é citado aqui.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in LoRA: abstract claims (10,000 times, 3 times, no additional inference latency), W0 + BA with rank r, 1.2 TB to 350 GB VRAM, 350 GB to 35 MB checkpoint with r = 4 on query and value matrices, task switching by swapping matrices.
- Verified in InstructGPT: recipe, 40 contractors, 13k, 33k and 31k prompt counts, 1.3B versus 175B preference, 85 ± 3% preference, 21% versus 41% closed-domain hallucination, about 25% fewer toxic outputs when prompted to be respectful, no significant bias improvement, alignment tax and PPO-ptx, the statement on whose preferences.
- Verified in DPO: description of RLHF, simple classification loss, no sampling during fine-tuning, comparison claims.
- Verified in QLoRA (abstract): the 65B on a single 48 GB GPU claim, frozen 4-bit base with LoRA, NF4, Double Quantization, Paged Optimizers, the Guanaco 99.3% claim, and the statements about GPT-4 evaluation and benchmarks. The paper's experiments were not reviewed.
- Verified in S-LoRA: adapters in main memory, Unified Paging, custom kernels and tensor parallelism, thousands of adapters, up to 4 times the throughput of vLLM with naive LoRA support and up to 30 times that of HuggingFace PEFT (the abstract gives only the 4 times figure; the introduction gives both).
- Verified in the MT-Bench paper: benchmark discrepancy statement, over 80% agreement, bias list.
- Verified in Llama 3: rounds of SFT then DPO, six rounds, rejection sampling with K between 10 and 30, PagedAttention over 2 times throughput, DPO versus PPO statement, learning rate and β, model averaging, data cleaning and pruning list, contamination analysis, violation and false refusal rates, Llama Guard.
- Labelled industry pattern, not sourced: the decision ladder, the release pipeline, shadow and canary rollout, monitoring, governance, cost arithmetic.
- Not claimed: how any specific vendor's fine-tuning product works.
- Corrected (independent review, 2026-10-27): the S-LoRA 4 times throughput figure holds for a small number of adapters; the introduction says so, and the benchmark models and GPUs are now stated.
