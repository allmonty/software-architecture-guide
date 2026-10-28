# 27 — LLM Training Infrastructure

*Partes de real-system do relatório Llama 3 da Meta, do MegaScale da ByteDance e dos papers do ZeRO da Microsoft. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Treinar um language model de fronteira significa manter milhares de GPUs ocupadas num único job síncrono por semanas. Três problemas dominam. **Memória:** os pesos, os gradientes e o estado do otimizador de um modelo não cabem numa GPU, então o modelo é dividido entre GPUs com vários tipos de paralelismo. **Comunicação:** as GPUs trocam dados o tempo todo, então a topologia de rede e as bibliotecas de coletivos decidem a eficiência. **Falha:** com tantas peças, algo quebra a cada poucas horas, e como o treinamento é síncrono uma GPU quebrada para todo mundo, então o sistema precisa detectar falhas, substituir nós e retomar de um checkpoint recente automaticamente. O sucesso é medido pela utilização (MFU) e pela parcela do tempo gasta em treinamento útil.

**Números principais** (como publicados, com o ano)
- O Llama 3 405B foi treinado em até 16K GPUs H100 (80 GB cada, oito por servidor), agendadas pelo scheduler MAST da Meta, com checkpoints num sistema de arquivos Tectonic de 240 PB sustentando 2 TB/s `[CONFIRMED]` (2024).
- Model FLOPs utilisation (MFU) relatada de 38–43% para as configurações do Llama 3 `[CONFIRMED]`; o MegaScale chegou a 55,2% de MFU num modelo de 175B com 12.288 GPUs, 1,34 vez o Megatron-LM `[CONFIRMED]`.
- Num snapshot de 54 dias o Llama 3 viu 466 interrupções de jobs, 419 delas inesperadas; cerca de 78% das inesperadas foram atribuídas a hardware, o paper declara as GPUs como 58,7% do total, embora as contagens da própria tabela deem cerca de 64% (Reviewer note 1) `[CONFIRMED]` como o número declarado pelo paper. O tempo efetivo de treinamento ficou acima de 90% `[CONFIRMED]`.
- ZeRO: o treinamento em precisão mista com Adam precisa de 16 bytes por parâmetro para pesos, gradientes e estado do otimizador; particionar os três entre 64 GPUs dá uma redução de 64 vezes na memória de estado do modelo por GPU `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Combinar paralelismo de tensor, pipeline, contexto e dados | Caber e acelerar um modelo que nenhuma GPU sozinha comporta | Uma configuração complexa, atrelada à topologia de rede |
| Fazer shard do estado do otimizador e dos gradientes (ZeRO/FSDP) | A memória por GPU diminui com o número de GPUs | Mais comunicação (até 50% mais para sharding completo no ZeRO) |
| Fazer checkpoint com frequência e rapidez | Menos trabalho perdido após uma falha | Escritas em rajada que saturam o storage; tempo de pausa da GPU |
| Automatizar o tratamento de falhas | Uma falha a cada poucas horas não pode esperar um humano | Exige diagnósticos profundos e capacidade sobressalente |
| Placement ciente de topologia | O tráfego entre pods é o recurso escasso | O scheduler e o plano de paralelismo precisam conhecer a rede |

**Erros comuns**
- Contar só a computação e esquecer que um job síncrono falha sempre que qualquer uma das GPUs falha.
- Tratar a utilização como um número só. MFU, tempo efetivo de treinamento e goodput medem perdas diferentes.
- Ignorar stragglers: uma GPU lenta pode atrasar milhares de outras.
- Fazer checkpoint raramente porque é caro, e depois perder horas a cada falha.

---

## 🧒 Non-technical explanation

Imagine **dezesseis mil pessoas construindo um único modelo enorme de Lego num estádio, em sincronia**. Ninguém consegue segurar o modelo inteiro, então cada pessoa segura uma fatia e elas passam peças o tempo todo aos vizinhos. Todos precisam terminar cada passo antes de o próximo começar, então se uma pessoa para para amarrar o sapato, milhares esperam. Os organizadores então fotografam o modelo a cada poucos minutos (checkpoints), mantêm inspetores atentos a quem trava, trocam essa pessoa por outra descansada e recomeçam da última foto, tudo sem uma reunião.

---

## TL;DR for engineers

- **Memória:** os estados do modelo custam cerca de 16 bytes por parâmetro com Adam em precisão mista `[CONFIRMED]` (ZeRO); particione-os entre os workers de data parallelism `[CONFIRMED]`.
- **Paralelismo:** o Llama 3 usou paralelismo 4D: tensor, pipeline, contexto e dados (totalmente com shard), ordenados pela demanda de rede `[CONFIRMED]`.
- **Rede:** um cluster RoCE de 24K GPUs numa rede Clos de três camadas, com scheduling ciente de topologia `[CONFIRMED]`.
- **Confiabilidade:** interrupções frequentes, diagnóstico automatizado, substituição de nós, checkpoint e recuperação rápidos `[CONFIRMED]` (Llama 3, MegaScale).
- **Scheduling, carregamento de dados, avaliação durante o treinamento, custo:** preocupações ao redor `[INDUSTRY PATTERN]` salvo se houver fonte.

---

## 1. Requirements (design framing)

**Funcionais:** executar um único job de treinamento muito grande em milhares de GPUs · agendar muitos jobs em clusters compartilhados · fazer checkpoint e retomar · alimentar dados continuamente · expor o progresso e ferramentas de depuração.

**Não funcionais:** **throughput e utilização** (MFU, tokens por segundo) · **confiabilidade** (tempo útil como parcela do tempo de relógio) · **recuperabilidade** (pouco trabalho perdido por falha) · **depurabilidade em escala** · **custo** (horas de GPU e energia) · **estabilidade numérica** (a loss converge).

**Perguntas de esclarecimento:** tamanho do modelo e comprimento de contexto? Orçamento de tokens e prazo? Número de GPUs e interconexão? Tolerância a falhas e orçamento de checkpoint? Cluster compartilhado ou dedicado? Como dados e avaliação são integrados?

---

## 2. Memory: why a model does not fit, and ZeRO `[CONFIRMED]` (Rajbhandari et al., 2020)

**O que usa memória.** O paper do ZeRO explica que os estados do modelo (parâmetros, gradientes, estado do otimizador) consomem a maior parte da memória do dispositivo. O treinamento em precisão mista com Adam guarda parâmetros e gradientes fp16 (2Ψ e 2Ψ bytes para Ψ parâmetros) mais parâmetros, momentum e variância fp32 (4Ψ + 4Ψ + 4Ψ), dando "16Ψ bytes". Um modelo de 1,5 bilhão de parâmetros precisa portanto de pelo menos 24 GB só para os estados do modelo. As ativações acrescentam mais: o exemplo do paper, um modelo de 1,5B com sequência de 1K e batch size 32, precisa de cerca de 60 GB, reduzidos a cerca de 8 GB por activation checkpointing (recomputação) a aproximadamente 33% de computação extra.

**O que o data parallelism simples faz.** Ele "does not reduce memory per device", ficando sem memória em modelos acima de cerca de 1,4B de parâmetros em GPUs de 32 GB, porque cada worker guarda uma cópia completa.

**ZeRO-DP.** Ele particiona os estados redundantes entre os workers de data parallelism em três estágios cumulativos: estado do otimizador (4 vezes menos memória, mesma comunicação do data parallelism), mais gradientes (8 vezes), mais parâmetros (a memória cai linearmente com o número de workers; para 64 GPUs uma redução de 64 vezes com um modesto aumento de 50% na comunicação). O exemplo do paper: um modelo de um trilhão de parâmetros precisa de cerca de 16 TB para esses estados, que divididos por 1.024 GPUs dão 16 GB cada. O fully sharded data parallelism (FSDP), que o Llama 3 usa, descende dessa ideia.

---

## 3. Parallelism at Llama 3 scale `[CONFIRMED]` (Llama Team, Meta, 2024)

O Llama 3 405B usou "4D parallelism": **tensor parallelism** (dividir os tensores de pesos entre dispositivos), **pipeline parallelism** (dividir o modelo por camadas em estágios), **context parallelism** (dividir a sequência de entrada, para contextos muito longos de até 128K tokens) e **data parallelism** com estado do otimizador e gradientes totalmente com shard. As GPUs são agrupadas na ordem [TP, CP, PP, DP]: a dimensão mais interna precisa da maior largura de banda e da menor latência e fica dentro de um servidor; a mais externa, o data parallelism, tolera uma rede de vários saltos porque pode fazer prefetch dos pesos com shard e reduzir os gradientes de forma assíncrona.

**Configurações relatadas (Tabela 4).** Por exemplo, 8.192 GPUs com TP 8, PP 16, DP 64 e sequência de 8K chegaram a 430 TFLOPs por GPU e 43% de MFU; 16.384 GPUs com DP 128 chegaram a 41%; o estágio de contexto longo com context parallelism de 16 chegou a 38%. O batch global ficou em 16M de tokens, então mais GPUs significaram um batch menor por grupo de data parallelism.

**Engenharia do pipeline.** Os autores modificaram o schedule do pipeline para permitir um número flexível de micro-batches, equilibraram os estágios removendo uma camada transformer do primeiro e do último estágios (o primeiro guarda o embedding, o último a projeção de saída e a loss) e usaram comunicação ponto a ponto assíncrona. Eles puderam fazer o pré-treinamento com sequências de 8K tokens sem activation checkpointing.

**Numérica.** Comparar a loss entre configurações de paralelismo expôs problemas numéricos; eles usam acumulação de gradientes em FP32 e reduce-scatter de gradientes em FP32.

---

## 3b. Why the combination is needed: Megatron-LM scaling `[CONFIRMED]` (Narayanan et al., 2021)

A configuração do Llama 3 se apoia num paper anterior da NVIDIA que explica por que cada técnica de paralelismo se esgota e como compô-las. (Só o abstract e a introdução deste PDF puderam ser extraídos como texto, então esta seção usa apenas essas partes.)
- **Os dois problemas:** os parâmetros de modelos grandes não cabem mais na memória nem da maior GPU, e a computação é enorme; o exemplo do paper é que treinar o GPT-3 175B "would require approximately 288 years with a single V100 NVIDIA GPU". O data parallelism sozinho deixa de escalar porque o batch size por GPU fica pequeno demais e o número máximo de dispositivos é o batch size.
- **O tensor parallelism quebra além de um servidor.** Dividir multiplicações de matrizes entre GPUs funciona para modelos de até cerca de 20 bilhões de parâmetros em servidores A100 de 8 GPUs, mas além disso o tráfego de all-reduce "needs to go through inter-server links", que são mais lentos que o NVLink de alta largura de banda dentro de um servidor multi-GPU, e uma divisão pesada cria multiplicações de matrizes pequenas que reduzem a utilização. É por isso que o tensor parallelism é posto na posição mais interna, dentro de um servidor, na ordem [TP, CP, PP, DP] do Llama 3.
- **O pipeline parallelism tem uma bolha.** As camadas são distribuídas em faixas entre GPUs e um batch é dividido em microbatches; para preservar a semântica estrita do otimizador o pipeline é esvaziado ao fim de cada batch, e "as much as 50% of time can be spent flushing the pipeline" dependendo do número de microbatches. Uma razão maior entre microbatches e tamanho do pipeline reduz o flush, então alta eficiência exige um batch maior. O paper introduz um **schedule de pipelining intercalado** que melhora o throughput em "10+%" com memória comparável.
- **Composição (PTD-P):** pipeline parallelism entre servidores, tensor parallelism dentro de um servidor e data parallelism por cima. O paper relata o treinamento de um modelo com 1 trilhão de parâmetros a 502 petaFLOP/s em 3072 GPUs, um throughput por GPU de 52% do pico teórico.

Esta é a origem da regra de placement da seção 3, e o número de 52% é um ponto de referência útil ao lado dos 38 a 43% do Llama 3 e dos 55,2% do MegaScale (modelos, hardware e definições diferentes, então não são diretamente comparáveis).

## 4. The cluster: compute, storage, network `[CONFIRMED]` (Llama 3)

- **Computação:** até 16K GPUs H100 de 700 W cada com 80 GB de HBM3, em servidores Grand Teton com oito GPUs e duas CPUs, ligados por NVLink dentro de um servidor. Os jobs são agendados pelo **MAST**, o scheduler global de treinamento da Meta.
- **Storage:** o Tectonic, um sistema de arquivos distribuído, forma o tecido de storage: 240 PB em 7.500 servidores SSD, 2 TB/s sustentáveis e 7 TB/s de pico. O desafio são as escritas de checkpoint em rajada que saturam brevemente o tecido. O estado salvo de cada GPU vai de 1 MB a 4 GB, e o objetivo é minimizar o tempo de pausa da GPU e aumentar a frequência de checkpoint para reduzir o trabalho perdido.
- **Rede:** RoCE (RDMA sobre Ethernet) para o modelo de 405B, InfiniBand para os menores, 400 Gbps entre GPUs. O cluster RoCE tem 24K GPUs numa rede Clos de três camadas: 16 GPUs por rack, 192 racks por pod de 3.072 GPUs com largura de banda de bisseção completa, oito pods por cluster com oversubscription de 1:7 no topo. O paralelismo e o scheduler são cientes de topologia para minimizar o tráfego entre pods. O Llama 3 usou até 16K das 24K GPUs.
- **Balanceamento de carga:** o treinamento produz poucos fluxos "gordos" que o roteamento ECMP balanceia mal, então a biblioteca de coletivos abre 16 fluxos entre duas GPUs e um ECMP aprimorado faz hash sobre campos extras do cabeçalho RoCE. Switches spine de buffer profundo absorvem a congestão transitória, e o cluster roda sem controle de congestão DCQCN.
- **Coletivos:** o NCCLX, um fork do NCCL ajustado para redes de alta latência, trata all-gather e reduce-scatter (FSDP) e ponto a ponto (pipeline).

---

## 5. Reliability: failures are the normal case `[CONFIRMED]`

**Números do Llama 3.** "The complexity and potential failure scenarios of 16K GPU training surpass those of much larger CPU clusters", e "a single GPU failure may require a restart of the entire job". Mesmo assim, o Llama 3 alcançou "higher than 90% effective training time" enquanto também fazia manutenção automatizada. Num período de 54 dias houve 466 interrupções: 47 planejadas (manutenção, atualizações de configuração ou de dataset) e 419 inesperadas. Cerca de 78% das inesperadas foram atribuídas a hardware confirmado ou suspeito. As causas de GPU (GPUs defeituosas, memória HBM3 e SRAM, processadores, térmica e corrupção silenciosa de dados) foram 58,7% do total segundo o paper (as contagens dele dão cerca de 64%, veja a Reviewer note 1); outras categorias grandes foram bugs de software, falhas de switch ou cabo de rede e manutenção não planejada de hosts. Só foi necessária intervenção manual três vezes; a automação tratou o resto.

**Ferramentas operacionais.** O time usou o NCCL flight recorder do PyTorch (um ring buffer de metadados de coletivos e stack traces despejado num timeout do watchdog), inicialização de jobs e checkpoint mais rápidos, e tracing mais pesado seletivo e habilitado ao vivo sem reiniciar. Os travamentos no NVLink muitas vezes aparecem como kernels CUDA pendurados sem erro, então a biblioteca de comunicação monitora o estado e aplica timeout. Os **stragglers** são hardware ainda funcionando mas lento; "even a single straggler can slow down thousands of other GPUs", encontrados priorizando comunicações suspeitas.

**Efeitos do ambiente.** Eles viram uma variação diurna de 1–2% no throughput ligada à temperatura, e oscilações de potência da ordem de dezenas de megawatts quando todas as GPUs esperam por um checkpoint ou iniciam e param juntas.

**O workflow de treinamento robusto do MegaScale (ByteDance, 2024).** Um processo driver aloca nós por meio de um Kubernetes customizado; cada executor roda um daemon que envia **heartbeats** com informações para detecção de anomalias. Quando o driver vê um status anormal ou perde um heartbeat, ele suspende o treinamento em todos os executors e roda **diagnósticos de autoverificação** leves, depois expulsa os nós defeituosos, repõe nós saudáveis e retoma a partir do último checkpoint. O checkpoint é em dois estágios: cada GPU copia seu estado para a memória do host (segundos) e continua, enquanto um processo em background escreve no HDFS. Na recuperação, um worker por grupo de data parallelism lê a partição compartilhada e a distribui, reduzindo a carga sobre o HDFS. Numa execução de produção de várias semanas em mais de 10.000 GPUs, o treinamento reiniciou mais de 100 vezes, e mais de 90% das falhas de software e de hardware foram encontradas e corrigidas automaticamente.

---

## 6. Reference view of the whole system `[INDUSTRY PATTERN]`

```
researcher ─► job scheduler (topology-aware) ─► GPU cluster (servers · NVLink · RoCE/InfiniBand fabric)
                                                      │
data store ─► data loaders ─► training job (TP · CP · PP · FSDP) ─► checkpoints ─► distributed file system
                                                      │
                          heartbeats · logs · flight recorder ─► fault detection ─► evict, replace, resume
```

- **Scheduler:** coloca os jobs pela topologia de rede, mantém nós sobressalentes e suporta janelas de manutenção automatizadas.
- **Pipeline de dados:** carregamento de dados determinístico e retomável para que um restart continue da mesma posição nos dados.
- **Avaliação durante o treinamento:** avaliação periódica em conjuntos reservados para pegar divergência cedo; pare ou faça rollback em picos de loss.
- **Custo e capacidade:** agende poucos jobs muito grandes e muitos pequenos, reserve folga para falhas, acompanhe a energia.
- **Passagem adiante:** o modelo concluído vai para o pós-treinamento e a avaliação (veja [28 LLM fine-tuning and evaluation](28-llm-finetuning-evaluation.md)) e para o serving (veja [22 LLM inference serving](22-llm-inference-serving.md)).

---

## 7. Capacity reasoning (illustrative)

- **Memória de estado do modelo** ≈ 16 bytes × parâmetros (fórmula do ZeRO). Para um modelo de 405 bilhões de parâmetros são cerca de 6,5 TB antes das ativações, e é por isso que os estados precisam ser divididos entre muitas GPUs. Esta é aritmética nossa usando a fórmula do paper.
- **Memória agregada das GPUs:** 16.384 GPUs × 80 GB ≈ 1,3 PB, então os estados com shard cabem com espaço para ativações e buffers.
- **Taxa de interrupção:** 419 interrupções inesperadas em 54 dias é aproximadamente uma a cada três horas (54 × 24 ÷ 419), nossa divisão das contagens relatadas. Um job que reinicia com essa frequência precisa de checkpoints medidos em minutos, não em horas.
- **Trabalho perdido por falha** ≈ metade do intervalo de checkpoint mais o tempo de restart. Dividir o intervalo pela metade divide pela metade a perda esperada e aumenta a carga de escrita de checkpoint.

---

## ⚠️ Reviewer notes

1. **A tabela de interrupções do Llama 3 é internamente inconsistente, e o total de 58,7% de GPU herda isso.** As contagens somam exatamente 419, mas a primeira linha lista 148 interrupções de GPU defeituosa a 30,1%, enquanto 148 de 419 é 35,3%; as porcentagens das outras linhas batem com suas contagens. Os 58,7% do paper são a soma da coluna de porcentagem nas linhas de GPU (30,1 + 17,2 + 4,5 + 4,1 + 1,4 + 1,4), então carregam o mesmo erro: calculadas a partir das contagens, as linhas de GPU (148 + 72 + 19 + 17 + 6 + 6 = 268) são 268 de 419, cerca de 64,0%. Relatamos o número do paper como sendo do paper e não dependemos dele; a parcela de causas de GPU fica em torno de 58,7% a 64%, dependendo de qual coluna está certa (encontrado por uma revisão independente e conferido por aritmética sobre a Tabela 5 do paper).
2. **Os números de MFU vêm de modelos e definições diferentes.** Os 38–43% do Llama 3 e os 55,2% do MegaScale usam modelos, hardware e baselines diferentes; não os compare como se viessem de um benchmark só.
3. **Estes são os clusters de duas empresas.** As fontes não descrevem os sistemas de treinamento do Google, da OpenAI ou da Anthropic, e não fazemos nenhuma afirmação sobre eles.
4. **O ZeRO é um paper de 2020.** O FSDP é uma implementação posterior da mesma ideia; o Llama 3 modifica como ele refaz o shard dos pesos do modelo.
5. **Not read:** as seções de dados de pré-treinamento do Llama 3, o corpo do paper de escalabilidade do Megatron-LM (o texto do PDF não foi extraído), os papers GPipe e PipeDream, treinamento de mixture-of-experts, sistemas baseados em TPU e análises de custo ou de energia.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes citadas. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance** (utilização), **confiabilidade/recuperabilidade**, **observabilidade**, **eficiência de custo**, **escalabilidade**.
- **Estilo (Ch 13):** um **tecido de computação fortemente acoplado e síncrono** gerenciado por um control plane (scheduler, detecção de falhas, recuperação).
- **Quanta (Ch 7):** o job de treinamento inteiro é um quantum arquitetural, que é exatamente por que qualquer falha isolada para tudo; o control plane e o storage são quanta separados.
- **Trade-off (First Law, Ch 1):** **utilização vs recuperabilidade.** Checkpoints e diagnósticos mais frequentes custam throughput e compram uma recuperação mais rápida.
- **Esboço de ADR (Ch 19):** *"Vamos fazer shard do estado do modelo entre os workers de data parallelism, posicionar as dimensões de paralelismo pela demanda de rede e fazer checkpoint em dois estágios com substituição automática de nós. Aceitamos o custo de engenharia do scheduling ciente de topologia em troca de maior utilização e tempo efetivo de treinamento."*
- Em linguagem simples: divida o modelo, mantenha os vizinhos por perto, fotografe com frequência e troque as peças quebradas rápido.

---

## Interview questions to practice

1. Como treinar um modelo que não cabe numa GPU?
2. Explique data, tensor e pipeline parallelism. Quando usar cada um?
3. Quanta memória o treinamento precisa por parâmetro, e o que o ZeRO muda?
4. Uma GPU falha a cada poucas horas num job de 16K GPUs. Como continuar progredindo?
5. Como você projetaria o checkpointing para um cluster enorme?
6. O que é um straggler, e como encontrar um?
7. Como a topologia de rede afeta o seu plano de paralelismo?
8. Como medir se o cluster está bem aproveitado?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: tamanho do modelo, tokens, GPUs, prazo, orçamento de falhas.
2. Estimar: memória por parâmetro, GPUs necessárias, tokens por segundo, falhas esperadas por dia.
3. Planejar o paralelismo: posicionamento das dimensões de tensor, pipeline, contexto e dados em relação à rede.
4. Projetar o control plane: scheduler, heartbeats e diagnósticos, substituição de nós, checkpointing.
5. Deep dive: formato, frequência e storage do checkpoint; carregamento de dados e retomada.
6. Falhas e escala: falha de uma GPU, straggler, saturação de storage, pico de loss, energia.

**Se crescer 10×**
- As falhas escalam com o número de GPUs: invista em automação e checkpoints mais rápidos antes de mais GPUs.
- A rede vira o limite: mais consciência de topologia e sobreposição de comunicação.
- Energia e refrigeração: escalone as fases sincronizadas.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Como manter o progresso com falhas frequentes?</summary>

Detecte rápido com heartbeats e timeouts, diagnostique com verificações automatizadas, expulse o nó ruim e traga um saudável, depois retome do último checkpoint. Mantenha os checkpoints frequentes e baratos com um salvamento em dois estágios, mantenha nós sobressalentes e automatize tudo que é comum para que humanos tratem apenas os casos raros.

</details>

<details><summary>Como fazer checkpoint nessa escala?</summary>

Cada GPU salva seu próprio shard; copie primeiro para a memória do host para que a GPU retome em segundos, depois escreva no sistema de arquivos distribuído em background. Na restauração, faça um worker por grupo de data parallelism ler e compartilhar o shard comum para evitar sobrecarregar o storage.

</details>

<details><summary>Por que a topologia importa?</summary>

O tensor parallelism troca dados a cada camada e precisa dos links mais rápidos, então fica dentro de um servidor; o data parallelism fica na posição mais externa porque pode fazer prefetch dos pesos com shard e reduzir os gradientes de forma assíncrona, então tolera a maior latência de cruzar pods. O scheduler precisa posicionar os grupos de modo que as dimensões de maior tráfego compartilhem links rápidos.

</details>

## 📚 Further reading

- As três fontes listadas em Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) para noções básicas de modelos e treinamento.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [22 LLM inference serving](22-llm-inference-serving.md), [28 LLM fine-tuning and evaluation](28-llm-finetuning-evaluation.md), [04 Kafka](04-message-queue-kafka.md) e [05 S3](05-object-storage-s3.md) para ideias de storage e replicação.

## Sources and provenance

> **Kind:** real system. O relatório do Llama 3 e o paper do MegaScale descrevem clusters reais de produção; o ZeRO descreve um método publicado. A visão de referência da seção 6 é o nosso formato-resumo.
> **Sources read on 2026-10-27 (texto dos PDFs extraído localmente):** Llama Team, Meta, [*The Llama 3 Herd of Models*](https://arxiv.org/pdf/2407.21783) (2024; Seção 3.3 Infrastructure, Scaling and Efficiency) · Jiang et al., [*MegaScale: Scaling Large Language Model Training to More Than 10,000 GPUs*](https://arxiv.org/pdf/2402.15627) (ByteDance, 2024) · Rajbhandari et al., [*ZeRO: Memory Optimizations Toward Training Trillion Parameter Models*](https://arxiv.org/pdf/1910.02054) (2020) · Narayanan et al., [*Efficient Large-Scale Language Model Training on GPU Clusters Using Megatron-LM*](https://arxiv.org/pdf/2104.04473) (2021; apenas abstract e introdução).
> **Dated material:** 2020–2024. O hardware e a prática se movem rápido.
> **Not read:** as seções de dados e receita de treinamento do Llama 3, o corpo do paper de escalabilidade do Megatron-LM e outros papers de pipeline, treinamento baseado em TPU, mixture-of-experts.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the Llama 3 report: 16K H100s, 700 W, 80 GB HBM3, eight GPUs per server with NVLink, MAST, Tectonic (240 PB, 7,500 servers, 2 TB/s sustained, 7 TB/s peak), checkpoint sizes 1 MB to 4 GB per GPU, RoCE and InfiniBand at 400 Gbps, the 24K Clos topology and 1:7 oversubscription, load balancing and congestion control, 4D parallelism and ordering, Table 4 MFU values, pipeline changes, NCCLX, 466 interruptions (47 planned, 419 unexpected), 78% hardware, 58.7% GPU, more than 90% effective training time, three manual interventions, straggler and environment observations. The table cell inconsistency is noted in the reviewer notes.
- Verified in MegaScale: 55.2% MFU on 12,288 GPUs and 1.34 times Megatron-LM, heartbeat and diagnostics workflow, two-stage checkpointing, shared read of data-parallel partitions, more than 100 restarts and over 90% automatic fixes in a multi-week run.
- Verified in the Megatron-LM scaling paper (abstract and introduction): the 288-year single-GPU example, the tensor-parallelism limit beyond one server, the up-to-50% pipeline flush, the interleaved schedule's 10+% gain, and 502 petaFLOP/s on 3072 GPUs at 52% of peak. Its experiments and recommendations in the body were not read.
- Verified in ZeRO: 16Ψ bytes with K = 12, the 24 GB and 60 GB / 8 GB examples, three stages with 4 times, 8 times and Nd times reductions, 50% extra communication, the trillion-parameter example on 1,024 GPUs.
- Labelled industry pattern, not sourced: the reference diagram, data-loader and evaluation practices, cost framing, and the arithmetic in section 7.
- Not claimed: the training systems of any company other than those in the sources.
