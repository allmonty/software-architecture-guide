# 16 — Reservation Scheduler (Hotel Rooms & Parking Spaces)

*Um reference design construído sobre building blocks verificados. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um reservation scheduler modela as reservas como um recurso e uma faixa de tempo, e deixa o banco de dados recusar sobreposições. No PostgreSQL, uma exclusion constraint sobre uma unidade e uma faixa semiaberta garante que não haja double booking, o inventário contado usa um contador protegido, e holds com TTL impedem que os usuários percam um slot enquanto pagam. A busca pode estar desatualizada, mas o caminho de escrita sempre confere de novo.

**Números principais**
- `UNIQUE` costuma ser inadequado para faixas; as exclusion constraints são a opção documentada `[CONFIRMED]`.
- Os limites de `tstzrange` não são canonicalizados, então passe `[)` explicitamente `[CONFIRMED]`.
- Idempotency keys do Stripe: até 255 caracteres, removidas após pelo menos 24 horas `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Exclusion constraint em (unidade, período) | Sobreposições impossíveis, não importa quem escreve | Escritas em um único shard e retries por conflito |
| Contadores protegidos para inventário em pool | Limite de capacidade simples | Atualizações de várias noites exigem ordenação para evitar deadlocks |
| Holds como linhas reais | Bloqueiam os outros durante o pagamento | Um sweeper e tratamento de expiração |

**Erros comuns**
- Usar um índice único em (quarto, início) para impedir sobreposições.
- Misturar limites abertos e fechados de modo que estadias consecutivas entrem em conflito.
- Confiar num lock distribuído em vez da constraint do banco.


---

## 🧒 Non-technical explanation

Um sistema de reservas é um **calendário de parede com uma regra: duas reservas não podem se sobrepor no mesmo quarto ou vaga**. Tudo que é difícil vem de várias pessoas esticando a mão para o mesmo quadradinho do calendário no mesmo instante.

- **Hotel:** você reserva *uma noite num tipo de quarto* ("um quarto duplo em 12 de dezembro"). O hotel tem, digamos, 40 duplos, então conta quantos estão ocupados. Pode ser que ele nem atribua o quarto físico até o check-in.
- **Estacionamento:** você reserva *uma faixa de horário numa vaga ou zona* ("Nível 2, 08:00–18:00"). Os slots são mais curtos, mudam com frequência (você estende, você passa do horário), e um carro que não aparece deveria liberar a vaga.

Os dois precisam das mesmas três coisas: **olhar** (está livre?), **segurar** (reservar por alguns minutos enquanto você paga), **confirmar** (é seu, ou o hold expira).

---

## TL;DR for engineers

- **Modele como `recurso × faixa de tempo`.** Um quarto de hotel, um tipo de quarto com uma contagem ou uma vaga de estacionamento são todos *recursos*, e uma reserva reivindica uma faixa de tempo em um deles.
- **Deixe o banco de dados impedir as sobreposições.** No PostgreSQL, uma **exclusion constraint** em `(resource WITH =, period WITH &&)` torna impossíveis reservas sobrepostas para um recurso, faça a aplicação o que fizer `[CONFIRMED]`. Para inventário *contado* (tipo de quarto por noite), use uma atualização de contador protegida.
- **Separe busca de reserva.** A busca pode ser eventualmente consistente (caches, índices). O caminho de **escrita** precisa conferir de novo contra a fonte da verdade.
- **Holds com TTL** impedem que os usuários percam um quarto na etapa de pagamento. Os holds contam como ocupados até expirarem.
- **Retries são normais.** A concorrência sob `REPEATABLE READ` ou `SERIALIZABLE` gera erros de serialização (SQLSTATE `40001`) que a aplicação **precisa repetir** `[CONFIRMED]`, e as chamadas de pagamento precisam de **idempotency keys** `[CONFIRMED]`.
- **Hotéis e estacionamentos diferem em granularidade e política** (noites vs minutos, overbooking, liberação de no-show), não no mecanismo central.

---

## 1. Requirements (design framing)

**Funcionais:** buscar disponibilidade (local, datas/horários, filtros) · ver o preço · **hold** · pagar e confirmar · modificar (mudar datas, estender) · cancelar com uma política · notificar · para estacionamento: controle de acesso de entrada/saída (QR code ou placa), tratamento de overstay.

**Não funcionais:** **nunca fazer double booking** da mesma unidade (restrição rígida) · latência de busca na casa das centenas de milissegundos · disponibilidade do caminho de reserva · correção acima da velocidade no caminho de escrita · auditabilidade (por que esta reserva foi aceita ou recusada?).

**Perguntas de esclarecimento que mudam o design:**

| Pergunta | Por que importa |
|---|---|
| A reserva é para uma **unidade específica** ou para um **tipo** (tipo de quarto, zona de estacionamento)? | Específica → exclusion constraint. Tipo → inventário contado. |
| Qual é a **granularidade de tempo**? (noites, horas, 15 minutos) | Escolha do tipo de range e do índice |
| O **overbooking** é permitido? | Permitido → o limite do contador é um número de negócio, não a capacidade |
| Duração do hold e modelo de pagamento (pagar agora, depois, pré-autorização)? | TTL do hold, passos da saga |
| As reservas podem ser **estendidas ou movidas**? | Reexecutar a checagem de sobreposição na nova faixa |
| Região única ou global? O inventário de um hotel é um shard natural? | Partition key (`hotel_id`, `lot_id`) |

---

## 2. Hotel rooms vs parking spaces

| | **Hotel** | **Estacionamento** |
|---|---|---|
| Recurso | Tipo de quarto com uma contagem (ex.: 40 duplos), ou um quarto específico | Uma vaga numerada, ou um **pool de zona/nível** com uma capacidade |
| Unidade de tempo | **Noites** (data de check-in até a data de check-out) | Minutos ou horas, geralmente no mesmo dia |
| Tipo de range natural | `daterange`, no calendário **local** da propriedade | `tstzrange` (UTC), com regras de tarifa aplicadas no fuso horário local do estacionamento |
| Atribuição | Frequentemente **tardia** (quarto atribuído no check-in) | Reservas de pool muitas vezes **não têm vaga atribuída** até a entrada |
| Churn típico | Baixo: mudar ou cancelar | **Alto**: extensões, overstays, saída antecipada, no-shows |
| Overbooking | Prática comum do setor para cobrir no-shows (política de negócio) | Possível em pools, arriscado em vagas numeradas |
| Controle de acesso | Cartão-chave no check-in | Cancela: QR code ou reconhecimento de placa na entrada e na saída |

Os mecanismos abaixo valem para os dois. A *escolha entre eles* segue a primeira linha.

---

## 3. Preventing double booking

### Option A: exclusion constraint on a specific resource `[CONFIRMED]`

A documentação do PostgreSQL afirma que `UNIQUE` "is usually unsuitable for range types. Instead, an exclusion constraint is often more appropriate". O exemplo deles da sala de reunião, depois de instalar o `btree_gist`, "will reject overlapping ranges only if the meeting room numbers are equal":

```sql
CREATE EXTENSION btree_gist;
CREATE TABLE room_reservation (
    room text,
    during tsrange,
    EXCLUDE USING GIST (room WITH =, during WITH &&)
);
```

Um insert sobreposto falha com `conflicting key value violates exclusion constraint`. A documentação define uma exclusion constraint como a que garante que "if any two rows are compared on the specified columns or expressions using the specified operators, at least one of these operator comparisons will return false or null", e observa que adicionar uma "will automatically create an index of the type specified".

Nossa adaptação para estacionamento (ilustrativa, não vem da documentação). Ela precisa de `CREATE EXTENSION btree_gist;` antes, porque `space_id` é um escalar comparado com `=` (a página do btree_gist lista classes de operador GiST para `bigint`, `text` e outros tipos escalares):

```sql
CREATE TABLE booking (
  id           uuid PRIMARY KEY,
  space_id     bigint NOT NULL,
  during       tstzrange NOT NULL,                 -- build as tstzrange(start, end, '[)')
  status       text NOT NULL CHECK (status IN ('HELD','CONFIRMED','CANCELLED')),
  hold_expires timestamptz,
  EXCLUDE USING GIST (space_id WITH =, during WITH &&)
         WHERE (status IN ('HELD','CONFIRMED'))     -- cancelled bookings don't block
);
```

- **Os limites importam.** Reservas consecutivas (10:00–12:00 e depois 12:00–14:00) não podem entrar em conflito, então use ranges semiabertos `[)`. A documentação diz que o construtor de dois argumentos cria um range "in standard form (lower bound inclusive, upper bound exclusive)", e que o `daterange` canonicaliza para `[)`. O **`tstzrange` não é canonicalizado**, então seus limites mantêm a inclusividade que você der. Sempre passe `'[)'` explicitamente para ranges de tempo. Isso é uma sutileza do texto da documentação, então declare os limites você mesmo.
- **Por que o banco e não a aplicação:** um check-then-insert na aplicação tem uma janela de race. Uma constraint que não é deferrable (o padrão) é checada na hora, não no commit: a página do CREATE TABLE diz "A constraint that is not deferrable will be checked immediately after every command", e só uma `DEFERRABLE` pode ser adiada para o fim da transação. O banco impõe isso independentemente de qual serviço escreve, então também protege contra bugs e ferramentas de back-office. As páginas que lemos não dizem como um segundo insert se comporta enquanto a primeira transação ainda não fez commit, então teste isso na sua versão `[INDUSTRY PATTERN]`.
- **Uma constraint condicional (parcial)**, como na cláusula `WHERE` acima, deixa as linhas canceladas ficarem para auditoria sem bloquear. A página do CREATE TABLE documenta isso: `EXCLUDE [ USING index_method ] ( exclude_element WITH operator [, ... ] ) index_parameters [ WHERE ( predicate ) ]`, e "The predicate allows you to specify an exclusion constraint on a subset of the table; internally this creates a partial index", com parênteses obrigatórios em volta do predicado.
- **Sintaxe mais nova (documentação do PostgreSQL 18).** Uma constraint `UNIQUE` pode receber `WITHOUT OVERLAPS` na última coluna: "If the WITHOUT OVERLAPS option is specified for the last column, then that column is checked for overlaps instead of equality", e a documentação diz que `UNIQUE (id, valid_at WITHOUT OVERLAPS)` se comporta como `EXCLUDE USING GIST (id WITH =, valid_at WITH &&)`. Então o aviso sobre `UNIQUE` vale para um índice único comum sobre um range ou sobre a coluna de início, não para esta forma. A sintaxe de `UNIQUE` não tem cláusula `WHERE`, então a forma parcial acima, que deixa as linhas canceladas ficarem, ainda precisa de `EXCLUDE` `[INDUSTRY PATTERN]` (nossa leitura da sintaxe). Não verificamos em qual versão ela apareceu; teste na sua.

### Option B: counted inventory (room type per night) `[INDUSTRY PATTERN]` with documented database behaviour

Quando não há unidade específica, mantenha uma linha por `(room_type, night)` com `capacity` e `sold`:

```sql
UPDATE inventory
   SET sold = sold + 1
 WHERE room_type_id = $1 AND night = $2 AND sold < capacity;   -- 0 rows updated → sold out
```

Para uma estadia de várias noites, atualize todas as noites **numa ordem fixa** dentro de uma transação (para evitar deadlocks entre duas estadias sobrepostas) e aborte se alguma linha atualizar zero linhas. O **limite de overbooking** é só uma `capacity` maior, que é um número de negócio. Comportamento do PostgreSQL que torna isso seguro `[CONFIRMED]`: sob `READ COMMITTED`, se um atualizador concorrente comita primeiro, "the search condition of the command (the WHERE clause) is re-evaluated to see if the updated version of the row still matches", então o segundo `UPDATE` vê `sold < capacity` contra o novo valor.

**Exemplo resolvido (nossa ilustração, com números inventados).** A tabela, uma linha por tipo de quarto e noite, com o guarda escrito também como constraint para que um bug não consiga vender além do limite:

```sql
CREATE TABLE inventory (
  room_type_id bigint NOT NULL,
  night        date   NOT NULL,
  capacity     int    NOT NULL,          -- rooms of this type we are willing to sell that night
  sold         int    NOT NULL DEFAULT 0,
  PRIMARY KEY (room_type_id, night),
  CHECK (sold <= capacity)
);
```

Digamos que o tipo de quarto 7 (um quarto duplo) tenha `capacity = 2` e nada vendido. Cada célula abaixo é `sold / capacity`:

| `night` | 10 Oct | 11 Oct | 12 Oct | 13 Oct |
|---|---|---|---|---|
| **Início** | 0 / 2 | 0 / 2 | 0 / 2 | 0 / 2 |
| O **Hóspede 1** reserva de 10 a 12 Oct (noites 10 e 11) | **1** / 2 | **1** / 2 | 0 / 2 | 0 / 2 |
| O **Hóspede 2** reserva de 11 a 13 Oct (noites 11 e 12) | 1 / 2 | **2** / 2 | **1** / 2 | 0 / 2 |
| O **Hóspede 3** pede de 11 a 12 Oct (noite 11) | 1 / 2 | `sold < capacity` é falso, **0 linhas atualizadas** | 1 / 2 | 0 / 2 |

Uma estadia cobre as noites do check-in até, mas sem incluir, a data de check-out, então uma reserva é uma linha por noite. O Hóspede 3 é recusado porque o `UPDATE` da noite 11 não casa nenhuma linha, e a aplicação então dá rollback na transação inteira. Se o Hóspede 3 tivesse pedido de 10 a 12 Oct, a atualização do dia 10 já teria tido sucesso e depois a do dia 11 falharia, e é por isso que todas as noites vão numa só transação: o dia 10 volta a `1 / 2` em vez de continuar contado. Os Hóspedes 1 e 2 atingem a noite 11, então atualizam a mesma linha; essa é a contenção que a ordem fixa de atualização e o locking em nível de linha resolvem. Definir `capacity` como 3 numa noite é como um hotel permite uma reserva a mais do que tem de quartos (o limite de overbooking acima): é só um número nessa linha.

### Option C: serializable isolation + retry `[CONFIRMED]`
Execute a checagem de disponibilidade e o insert dentro de uma transação `SERIALIZABLE` e repita em caso de falha. A documentação: "applications using this level must be prepared to retry transactions due to serialization failures", e um tratador de retry deve tratar o SQLSTATE **`40001`** de forma genérica, "because it will be very hard to predict exactly which transactions might contribute to the read/write dependencies and need to be rolled back". Sob `REPEATABLE READ`, um update concorrente comitado na mesma linha resulta em `could not serialize access due to concurrent update`, e a aplicação "should abort the current transaction and retry the whole transaction from the beginning".

### Option D: hold in a fast store first `[INDUSTRY PATTERN]`
Uma chave Redis `hold:{resource}:{slot}` com `SET ... NX PX <ttl>` pode dar uma primeira reivindicação barata (a documentação do Redis: `NX` é "Only set the key if it does not already exist.", e `PX` define a expiração em milissegundos), mas **não** é a fonte da verdade. A constraint do banco continua decidindo. Use-a só para reduzir a contenção, e aceite que uma chave perdida (restart, eviction) nunca pode permitir um double booking.

| Opção | Impede | Trata ranges? | Precisa de retry? | Melhor para |
|---|---|---|---|---|
| A. Exclusion constraint | Qualquer sobreposição numa unidade específica | **Sim, nativamente** | No erro de conflito | Vagas numeradas de estacionamento, quartos específicos |
| B. Contador protegido | Vender além de uma contagem | Linhas por noite/slot | Em zero linhas ou deadlock | Tipos de quarto, zonas de estacionamento |
| C. Serializable + retry | Anomalias em lógica complexa de várias linhas | Qualquer | **Sim, sempre** | Regras que não cabem em A ou B |
| D. Hold em Redis | Apenas contenção | Por chave | n/a | Uma linha de frente, nunca a verdade |

---

## 4. Hold → pay → confirm

```
search (eventually consistent) ─► choose ─► HOLD (insert row status=HELD, hold_expires = now()+10 min)
                                              │ constraint rejects overlaps; held rows block others
                                              ▼
                                  payment (idempotency key) ─ success ─► CONFIRMED
                                              │ failure / timeout / expiry
                                              ▼
                                  release: status = CANCELLED (frees the range)
```

- **O hold é uma linha real** dentro do `WHERE` da exclusion constraint, então bloqueia os outros. Um **job sweeper** (ou uma checagem na leitura) marca os holds expirados como `CANCELLED` `[INDUSTRY PATTERN]`. Trate `hold_expires < now()` como livre também no momento da consulta, para que um sweeper lento não esconda inventário. Mas a constraint não enxerga o relógio: uma linha `HELD` expirada que ainda não foi varrida continua satisfazendo o predicado `WHERE (status IN ('HELD','CONFIRMED'))`, então um novo insert para a mesma faixa falharia até o sweeper rodar. A transação de reserva deveria, portanto, primeiro cancelar quaisquer holds expirados naquela unidade e faixa (`UPDATE booking SET status = 'CANCELLED' WHERE space_id = $1 AND during && $2 AND status = 'HELD' AND hold_expires < now()`) e depois inserir, na mesma transação `[INDUSTRY PATTERN]` (raciocínio nosso: um predicado de constraint não pode chamar `now()`).
- **Pague com uma idempotency key.** Stripe `[CONFIRMED]`: o cliente gera a chave (até 255 caracteres, UUIDs V4 sugeridos). Na API v1, o Stripe salva o status code e o corpo da primeira requisição depois que a execução começa, e retries com a mesma chave devolvem a resposta salva, "including `500` errors". As chaves podem ser removidas após pelo menos 24 horas. Uma chave reutilizada com **parâmetros diferentes dá erro**. Falhas de validação e conflitos de requisição concorrente não são salvos, então podem ser repetidos. Todas as requisições `POST` aceitam chaves, `GET` e `DELETE` não precisam delas.
- **Consequência para o design:** derive a chave de `(booking_id, número da tentativa)`, não de um `booking_id` puro. Um retry com outro cartão muda os parâmetros, o que daria erro sob a mesma chave `[INDUSTRY PATTERN]`, inferido do comportamento documentado.
- **Saga, não uma transação distribuída:** reservar → pagar → confirmar, com compensação (cancelar o hold, reembolsar) na falha. Use um **transactional outbox** para que os eventos de "reserva confirmada" (e-mail, código de acesso) não se percam se o processo morrer depois do commit `[INDUSTRY PATTERN]` (veja [04 Message queue](04-message-queue-kafka.md) e [10 Notification system](10-notification-system.md)).
- **Confirme apenas se o hold ainda for válido.** O passo de confirmação precisa rechecar `status = 'HELD' AND hold_expires > now()`. Um pagamento que termina *depois* de o hold expirar precisa de uma política: reembolsar, ou tentar retomar o slot, e rechecar a constraint `[INDUSTRY PATTERN]`.

---

## 5. Availability search vs the booking write path `[INDUSTRY PATTERN]`

- **A busca tem muita leitura** (muitas consultas por reserva). Sirva-a a partir de um **índice de busca ou cache** com chave por local, faixa de datas e filtros, alimentado a partir do banco de inventário por eventos de mudança. Pode estar segundos desatualizada.
- **Nunca confie na busca para a resposta final.** O caminho de escrita rechecá e a constraint decide. Um erro de "acabou de esgotar" depois de uma busca desatualizada é aceitável, um double booking não é.
- **Faça sharding por propriedade ou estacionamento** (`hotel_id`, `lot_id`): todas as reservas de uma unidade vivem num shard, então a checagem de sobreposição é uma operação de shard único. Buscas entre propriedades se espalham para o índice, não para os shards de reserva.
- **Guarde em cache as contagens de disponibilidade por (unidade, noite)** com TTLs curtos, e invalide nas mudanças de reserva.

---

## 6. Parking-specific behaviour `[INDUSTRY PATTERN]` unless tagged

- A **extensão** é uma *nova checagem de sobreposição numa faixa adjacente*: o período estendido também precisa passar pela exclusion constraint. Se o próximo slot está ocupado, a extensão precisa falhar ou mover o carro.
- **Overstay:** o carro ainda está lá depois que o seu `during` terminou. O sistema de acesso detecta isso na saída. As opções são cobrar uma tarifa de multa ou bloquear o início da próxima reserva até a vaga ficar vazia. Isso é uma política de negócio, e mostra por que um modelo puramente de calendário não basta: o estado físico (`OCCUPIED`) pode diferir do estado reservado.
- **Liberação de no-show:** se ninguém entra dentro de um período de tolerância, marque a reserva como `NO_SHOW` e libere a vaga para quem chega sem reserva, conforme a política.
- **Pools vs vagas numeradas:** reservas de pool (inventário contado por faixa de horário) são mais simples e sobrevivem a vagas fora de serviço. Reservas de vaga numerada dão um lugar garantido.
- **Preço dinâmico:** o preço depende da demanda, do horário e da duração. Mantenha o serviço de preços separado do núcleo de inventário e **guarde o preço junto com a reserva** para que mudanças posteriores de preço não o alterem.
- **Fusos horários e horário de verão:** os horários do estacionamento são instantes absolutos (guarde em UTC), mas o limite de uma "tarifa diária" é no horário local do estacionamento. As noites de hotel são **datas de calendário locais**, e é por isso que um `daterange` no fuso horário da propriedade se encaixa.

---

## ⚠️ Reviewer notes

1. **`UNIQUE` não consegue expressar "sem sobreposição".** Um índice único em `(room, start)` permite ranges sobrepostos com inícios diferentes. Esse é o erro de entrevista mais comum, e a própria documentação do PostgreSQL diz que o `UNIQUE` é "usually unsuitable for range types".
2. **Limites abertos vs fechados são fonte de bugs.** Duas estadias consecutivas compartilham um instante de fronteira. Use `[)` de forma consistente e passe os limites explicitamente para o `tstzrange`.
3. **Overbooking é uma decisão de negócio.** Alguns hotéis vendem deliberadamente além da capacidade para cobrir no-shows. Essa é uma prática do setor descrita em termos gerais, não algo que fundamentamos em fontes aqui. Torne o limite um número de configuração e tenha um fallback definido (realocar o hóspede). Nunca faça overbooking de vagas numeradas de estacionamento sem um plano.
4. **Locks distribuídos não substituem a constraint do banco.** Um serviço de lock pode expirar ou ser particionado. Use-o apenas para reduzir a contenção.
5. **Um modelo `HELD`/`CONFIRMED` limpo ainda precisa de tempo.** Os sweepers atrasam, os relógios diferem entre servidores, e um pagamento pode terminar depois de o hold ter vencido. Use o `now()` do banco para as decisões de expiração, não o relógio de cada servidor de aplicação `[INDUSTRY PATTERN]`.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não da documentação citada. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **integridade dos dados** (sem double booking), **confiabilidade**, **disponibilidade** da busca, **performance** da busca vs correção da reserva, **auditabilidade**.
- **Estilo (Ch 13/17):** uma divisão **service-based** em busca, reserva (inventário), preços, pagamento e notificação. O núcleo de inventário é deliberadamente **um store fortemente consistente, com um shard por propriedade**, e o restante são consumidores event-driven.
- **Quanta (Ch 7):** a busca pode ser um quantum separado (eventualmente consistente, pode atrasar). O núcleo de reserva mais a saga de pagamento é outro, e precisa estar correto mesmo quando a busca está desatualizada.
- **Trade-off (First Law, Ch 1):** **consistência vs disponibilidade no caminho de escrita.** A correção vem primeiro: uma reserva recusada é melhor que um double booking, então o caminho de escrita aceita erros ocasionais de "tente de novo".
- **Esboço de ADR (Ch 19):** *"Vamos impor a ausência de sobreposição com uma exclusion constraint do PostgreSQL em (unidade, período) e usar contadores protegidos para inventário em pool. Aceitamos retries por falha de serialização e escritas em um único shard por propriedade."*
- Em linguagem simples: o próprio calendário se recusa a ser escrito duas vezes, então ninguém precisa ser confiável para conferir antes.

---

## Interview questions to practice

1. Dois usuários reservam o último quarto para a mesma noite no mesmo instante. Mostre exatamente como o seu design impede o segundo.
2. Por que uma unique constraint em `(room_id, start_time)` não basta? O que você usaria no lugar?
3. Projete o hold: quanto tempo, qual status, o que o expira e o que acontece quando o pagamento termina depois da expiração?
4. Hotel com 40 duplos vs uma garagem com vagas numeradas: como as tabelas de inventário diferem?
5. Um hóspede estende o estacionamento por duas horas, mas o próximo slot está reservado. O que o sistema faz?
6. Como você permitiria overbooking controlado, e qual é o fallback?
7. A busca diz disponível, a reserva diz esgotado. Isso é um bug?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: unidade ou pool, granularidade, overbooking, extensões.
2. Estimar: reservas, buscas por reserva.
3. API: buscar, hold, confirmar, cancelar.
4. Design: índice de busca, serviço de reservas, banco de inventário, pagamento.
5. Deep dive: exclusion constraints, holds, pagamento idempotente.
6. Falhas e escala: holds expirados, pagamento tardio, overstay.

**Se crescer 10×**
- Carga de busca: um índice ou cache desatualizado com uma rechecagem final.
- Propriedades quentes: sharding por propriedade e escritas em um único shard.
- Tempestades de retry: back-off nas falhas de serialização.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Dois usuários reservam o último quarto ao mesmo tempo. Como o segundo é barrado?</summary>

Ambos inserem uma reserva HELD com ranges sobrepostos. A exclusion constraint deixa um comitar e rejeita o outro, qualquer que seja o serviço que escreve.

</details>

<details><summary>Projete o hold.</summary>

Uma linha HELD com uma expiração dentro da constraint, uma etapa de pagamento com uma idempotency key, um sweeper que cancela holds expirados (mais o cancelamento de holds expirados dentro da transação de reserva, já que a constraint não enxerga o relógio) e uma confirmação que rechecá se o hold ainda é válido.

</details>

<details><summary>Tipos de hotel vs vagas numeradas de estacionamento?</summary>

Os tipos de quarto são inventário contado por noite. As vagas numeradas usam um range por unidade com uma exclusion constraint. O estacionamento acrescenta extensões, overstay e liberação de no-show.

</details>

## 📚 Further reading

- Documentação do PostgreSQL: [Range types](https://www.postgresql.org/docs/current/rangetypes.html), [Exclusion constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html), a extensão [`btree_gist`](https://www.postgresql.org/docs/current/btree-gist.html), [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html) (a cláusula `EXCLUDE` e o momento da checagem) e o [`SET`](https://redis.io/docs/latest/commands/set/) do Redis.
- [Stripe: Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- A [nota anterior `neokim-post/12` Airbnb / Booking.com](https://github.com/allmonty/study/blob/main/architecture/neokim-post/12-how-airbnb-works.md) para o fluxo de hotel, estimativas, opções de row-lock e version-check, e as reviewer notes sobre contagem de propriedades.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [17 Payment system](17-payment-system.md), [10 Notification system](10-notification-system.md), [02 Rate limiter](02-rate-limiter.md).

## Sources and provenance

> **Kind:** reference design, com seus principais mecanismos de correção fundamentados na documentação do PostgreSQL e do Stripe. O Booking.com, o Airbnb e as operadoras de estacionamento não publicam os internals de suas reservas com detalhe suficiente para verificar, então o formato do sistema é o design padrão `[INDUSTRY PATTERN]`. O que **é** verificado: como os range types e as **exclusion constraints** do PostgreSQL impedem reservas sobrepostas, como seus níveis de isolamento se comportam sob concorrência e como funcionam as idempotency keys de pagamento.
> **Basis:** generaliza a [`neokim-post/12` (Airbnb / Booking.com)](https://github.com/allmonty/study/blob/main/architecture/neokim-post/12-how-airbnb-works.md), que cobre o fluxo de hotel em profundidade, para um scheduler que também trata **vagas de estacionamento**. Esta nota trata do *núcleo de inventário e concorrência*. Os pagamentos são cobertos em [17 Payment system](17-payment-system.md).
> **Sources read on 2026-10-29:** documentação do PostgreSQL (versão atual, 18 na data de leitura): [Range types](https://www.postgresql.org/docs/current/rangetypes.html), [Constraints (exclusion constraints)](https://www.postgresql.org/docs/current/ddl-constraints.html), [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html), [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html), [btree_gist](https://www.postgresql.org/docs/current/btree-gist.html) · [Stripe: Idempotent requests](https://docs.stripe.com/api/idempotent_requests) · [`SET`](https://redis.io/docs/latest/commands/set/) do Redis. As referências de locking do PostgreSQL e da Adyen da nota anterior foram verificadas no seu próprio log e não são relidas aqui.
> **Tags:** `[CONFIRMED]` afirmado pela documentação do PostgreSQL ou do Stripe · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível, ou uma escolha de política de negócio.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* PostgreSQL and Stripe pages were fetched and quoted.
- Verified in PostgreSQL range-type docs: `UNIQUE` "usually unsuitable for range types"; exclusion constraints "often more appropriate"; the `room_reservation` example with `btree_gist` and `EXCLUDE USING GIST (room WITH =, during WITH &&)`; the error message; `tstzrange` and `daterange` exist; two-argument constructor defaults to `[)`; `int4range`, `int8range` and `daterange` canonicalise to `[)` while `tstzrange` is not listed.
- Verified in the constraints docs: exclusion-constraint definition and that an index is created automatically.
- Re-read 2026-10-29 in the CREATE TABLE page: the `EXCLUDE ... [ WHERE ( predicate ) ]` syntax and its partial-index wording, and that a non-deferrable constraint is checked immediately after every command. In the btree_gist page: its GiST operator classes cover `bigint` and `text` equality. In the Redis page: `NX` and `PX` as described above.
- Verified in the isolation docs: serializable retry requirement and SQLSTATE `40001`; the repeatable-read "could not serialize access due to concurrent update" error and the retry-whole-transaction advice; read-committed re-evaluation of the `WHERE` clause.
- Verified in Stripe's docs: idempotency key behaviour for API v1 (saved status and body including 500s, key length 255, pruning after at least 24 hours, parameter mismatch error, validation and concurrency conflicts not saved, GET and DELETE need no key).
- Re-read 2026-10-29 in the CREATE TABLE page: `UNIQUE ... WITHOUT OVERLAPS` and the sentence that it is enforced like an `EXCLUDE` constraint.
- Not read: how a concurrent insert behaves while the first transaction is uncommitted (not stated in the pages above), Redis eviction and restart behaviour, any hotel or parking operator documentation.
- Labelled as industry pattern, not sourced: overbooking practice, hold and sweeper design, search/booking split, parking extension, overstay and no-show behaviour, dynamic pricing, time-zone handling.
- Derived by us from documented behaviour: the "idempotency key = booking id + attempt number" advice follows from Stripe's rule that a changed-parameter retry on the same key errors.
- Added (independent review, 2026-10-27): an expired hold that the sweeper has not yet cancelled still blocks the exclusion constraint, because the constraint's predicate cannot depend on the current time; the note now says to cancel expired holds in the booking transaction. This is our reasoning, not a quoted source.
