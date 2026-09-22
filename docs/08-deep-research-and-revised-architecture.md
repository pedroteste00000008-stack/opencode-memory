# Pesquisa aprofundada e arquitetura revisada

> **Data:** 2026-09-21  
> **Status:** direção arquitetural adotada para a próxima fase de design e benchmark.  
> **Precedência:** este documento corrige e refina as premissas de `01-architecture.md` a `07-implementation-plan.md`. As escolhas de storage, embedding, reranker e thresholds continuam **provisórias até benchmark local reproduzível**.

## 1. Resumo executivo

A pesquisa inicial identificou componentes úteis — Laya, embeddings locais, reranking e persistência vetorial — mas fechou cedo demais decisões como ChromaDB, `all-MiniLM-L6-v2`, três collections fixas, pruning por idade e um serviço FastAPI em porta fixa.

Para um agente de software, a qualidade da memória depende principalmente de:

1. **semântica da memória** — o que é uma memória e como ela difere da evidência original;
2. **proveniência** — de onde a memória veio e quão confiável é;
3. **atualização e conflito** — como uma decisão nova substitui uma antiga;
4. **escopo** — usuário, projeto, workspace/worktree, branch, sessão e tarefa;
5. **retrieval** — recuperar símbolos exatos e relações semânticas;
6. **controle de contexto** — injetar pouca memória, relevante e não obsoleta;
7. **avaliação** — medir recall, atualização correta, latência, RAM e poluição de contexto.

A arquitetura revisada passa a tratar memória como **conhecimento derivado e versionado sobre evidências imutáveis**, e não apenas como mensagens vetorizadas.

## 2. Princípio central: evidência não é memória

O sistema deve manter duas camadas distintas.

### 2.1 Evidência

Registro do que realmente ocorreu:

- mensagem do usuário;
- mensagem do assistente;
- chamada e resultado de tool;
- comando executado;
- resultado de teste/build;
- evento de sessão;
- commit/PR/issue quando disponível;
- checkpoint de compaction;
- metadata de projeto, workspace e sessão.

A evidência deve ser tratada como fonte auditável. Ela pode ser imutável ou append-only, salvo políticas explícitas de retenção/privacidade.

### 2.2 Memória derivada

Uma unidade autocontida criada a partir de uma ou mais evidências, por exemplo:

```text
No projeto X, a persistência local foi alterada de ChromaDB para SQLite.
```

Essa unidade deve apontar para suas fontes. O agente não deve reciclar uma afirmação própria como fato apenas porque ela apareceu em uma resposta anterior.

Essa separação permite:

- corrigir ou retrair memória sem destruir histórico;
- explicar por que uma memória existe;
- reprocessar memórias quando o schema/modelo mudar;
- distinguir fala, intenção, tentativa, resultado e fato confirmado;
- impedir ciclos em que contexto injetado volta a ser armazenado como nova “evidência”.

## 3. Arquitetura-alvo

```text
                    OpenCode
      messages / tools / tests / git / events
                        |
            +-----------+-----------+
            |                       |
        WRITE PATH               RECALL PATH
            |                       |
      capture evidence          current request
            |                       |
   extract candidates        query/facet builder
            |                       |
       Laya decision       scope + validity filter
            |                       |
 existing-memory lookup    +--------+--------+
            |              |                 |
      consolidation       lexical          dense
 ADD / UPDATE /          BM25/FTS          vectors
 SUPERSEDE / NOOP          |                 |
 CONFLICT                   +--------+--------+
            |                    fusion
       versioning                 |
            |               optional rerank
     canonical store              |
            |               diversity/budget
      indexes / FTS               |
                            context hook
                         ephemeral injection
```

O Laya é um **motor de decisão** dentro do pipeline, não o componente responsável por gerar ou reescrever o conteúdo da memória.

## 4. Modelo canônico de memória

O schema inicial deve comportar atualização temporal e proveniência desde a v1.

Exemplo conceitual:

```typescript
interface MemoryRecord {
  id: string
  content: string
  kind: MemoryKind
  scope: MemoryScope

  status: "active" | "superseded" | "retracted"
  supersedesId?: string

  createdAt: number
  validFrom?: number
  validUntil?: number

  sourceIds: string[]
  sourceKind: "user" | "assistant" | "tool" | "test" | "git" | "system"
  confidence?: number

  projectId?: string
  repository?: string
  workspaceId?: string
  worktree?: string
  branch?: string
  sessionId?: string
  taskId?: string

  extractorVersion: string
  decisionModel: string
  embeddingModel?: string

  metadata?: Record<string, unknown>
}
```

O embedding é um índice derivado. Ele não deve ser a identidade nem a fonte de verdade da memória.

## 5. Tipos de memória

Evitar usar collections físicas como taxonomia semântica. Um armazenamento canônico único com `kind` e índices permite evolução mais segura.

Tipos iniciais candidatos:

- `preference` — preferência estável do usuário;
- `decision` — decisão técnica ou de produto;
- `fact` — fato confirmado sobre projeto/ambiente;
- `constraint` — restrição obrigatória;
- `procedure` — procedimento reutilizável;
- `failure_lesson` — tentativa, falha, causa e correção;
- `project_state` — estado resumido e mutável de uma iniciativa;
- `relationship` — relação estável entre entidades quando útil.

Uma memória procedural para agentes de código deve capturar, quando disponível:

```text
Contexto
Tentativa
Falha observada
Causa
Correção
Evidência de sucesso
Escopo em que a lição vale
```

Isso é mais útil do que simplesmente guardar um turno bruto de conversa.

## 6. Escopo é uma dimensão independente

A mesma categoria pode existir em vários níveis:

- global do usuário;
- organização;
- projeto/repositório;
- workspace/worktree;
- branch;
- sessão;
- tarefa.

Exemplos:

- “prefiro TypeScript” pode ser global;
- “neste projeto não use Lombok” é projeto-específico;
- “nesta branch estamos migrando o registry” é branch-específico.

O retrieval deve priorizar escopos mais específicos e nunca misturar projetos por similaridade sem autorização/configuração explícita.

## 7. Pipeline de escrita

### 7.1 Captura

Registrar a evidência concluída com idempotency key estável sempre que possível.

### 7.2 Extração

Produzir candidatos autocontidos a partir de evidências relevantes. O extrator pode inicialmente ser um LLM já disponível no OpenCode ou outro componente separado; o Laya não substitui essa função porque ele retorna decisões tipadas, não texto novo.

### 7.3 Decisão com Laya

O Laya pode responder perguntas tipadas como:

- vale persistir?;
- qual o tipo?;
- qual o escopo provável?;
- é temporário?;
- a nova evidência contradiz memória ativa?;
- a confiança é suficiente para auto-store?;
- requer revisão/abstenção?

### 7.4 Consolidação

Antes de inserir, buscar memórias potencialmente equivalentes ou conflitantes e escolher uma operação explícita:

- `ADD` — nova memória;
- `UPDATE` — mesma memória, conteúdo/metadata refinados;
- `SUPERSEDE` — informação nova substitui a anterior;
- `NOOP` — duplicata ou ausência de novidade;
- `CONFLICT` — contradição sem evidência suficiente para escolher vencedora.

### 7.5 Versionamento

Exemplo:

```text
2026-09-01: "Neste projeto usaremos ChromaDB."
2026-09-21: "Decidimos substituir ChromaDB por SQLite."
```

A segunda memória deve superseder a primeira; ambas permanecem auditáveis.

## 8. Retrieval: lexical + semântico

Dense-only não é suficiente para desenvolvimento de software.

Consultas como:

- `ExecutionContract`;
- `src/foo/bar.ts`;
- SHA de commit;
- `NullPointerException`;
- nome de issue;
- símbolo exato de API;

possuem forte componente lexical.

Pipeline recomendado para benchmark:

```text
query
  |
  +--> filtros de escopo/validade/tempo
  |
  +--> lexical BM25 / FTS
  |
  +--> dense retrieval
          |
          +--> rank fusion (ex.: RRF)
                    |
               oversampling
                    |
              reranker opcional
                    |
            diversity + token budget
                    |
              3-8 memórias úteis
```

Não combinar diretamente `similarity_score` e `rerank_score` por média sem calibração. Backends diferentes também podem usar escalas e sentidos diferentes para score/distância.

## 9. Papel do Laya

### 9.1 Correção da premissa linguística

O default inglês `convaiinnovations/laya` não deve ser assumido como ideal para um plugin PT/EN.

O próprio projeto Laya publica:

- checkpoint inglês;
- `laya-multilingual`;
- `laya-typed-decisions`;
- `Router` para roteamento entre checkpoints.

O checkpoint inglês degrada fora do inglês e pode permanecer confiante mesmo quando está errado. Para o primeiro benchmark do plugin, a hipótese preferida é testar **`laya-multilingual` isolado** contra Router PT/EN, em vez de assumir o inglês como default.

### 9.2 Custo de Router

Com `Router(max_loaded=1)`, alternância de idiomas pode recarregar checkpoint. O repositório do Laya documenta cold loads de vários segundos; preload elimina reload, mas aumenta memória residente.

Portanto:

- medir em CPU real;
- evitar números de GPU como expectativa universal;
- comparar `laya-multilingual` único vs Router;
- registrar p50/p95, RAM e tempo de cold start.

### 9.3 Onde usar Laya

Bom candidato:

- classificação tipada;
- should-store;
- política de atualização;
- conflito;
- validade provável;
- threshold de revisão.

Não assumir que um filtro Laya depois do reranker é necessário. Esse estágio pode criar falso negativo e latência. Deve permanecer apenas se o benchmark mostrar ganho.

## 10. Embeddings e reranker: candidatos, não decisões finais

A seleção original de `all-MiniLM-L6-v2` e `ms-marco-MiniLM-L-12-v2` favorece inglês.

### 10.1 Embeddings a benchmarkar

Baseline mínimo:

- `multilingual-e5-small` — 384 dimensões, 100+ idiomas;
- EmbeddingGemma — multilingual, 2K de contexto, 768 com opções Matryoshka menores;
- MiniLM atual como controle barato.

EmbeddingGemma deve ter seus termos/licença avaliados separadamente de modelos Apache/MIT.

### 10.2 Reranking

Candidatos:

- FlashRank atual;
- opção multilingual do FlashRank;
- reranker multilingual adicional se a diferença justificar custo.

Reranking deve ser opcional e medido. Para corpus pequeno ou consultas exatas, híbrido + rank fusion pode ser suficiente.

## 11. Storage: decisão adiada até benchmark

ChromaDB continua sendo candidato, mas não deve ser premissa arquitetural.

Comparar pelo menos:

- SQLite + FTS5 + índice vetorial/extensão adequada;
- LanceDB;
- ChromaDB.

Critérios:

- instalação local;
- footprint;
- atomicidade;
- CRUD e versionamento;
- filtros;
- FTS/BM25;
- busca vetorial;
- migração de schema;
- backup;
- concorrência;
- portabilidade;
- recuperação após crash.

SQLite é particularmente interessante porque FTS5 fornece busca textual e BM25 no mesmo arquivo do estado canônico, reduzindo componentes. Isso precisa ser validado junto da opção vetorial escolhida.

## 12. Integração correta com OpenCode V2

A API V2 atual diferencia:

### `prompt`

Executa antes da admissão durável do prompt. Alterações viram entrada canônica persistida. Também não deve ser tratado como fronteira exactly-once para efeitos colaterais.

**Consequência:** não usar o prompt hook para injetar automaticamente bloco de memória, pois isso pode persistir contexto recuperado e favorecer reingestão/duplicação.

### `context`

Executa imediatamente antes da chamada do agent loop. Alterações afetam somente a requisição enviada ao modelo.

**Uso preferido:** recall automático e injeção efêmera de memória.

### `compaction`

Fluxo próprio para checkpoint/resumo. Memória de longo prazo não deve depender exclusivamente de compaction, porque compaction é uma representação lossy do histórico.

### `generate` e `title`

São requests auxiliares separados. Não aplicar contexto de memória automaticamente sem decidir explicitamente que esses fluxos precisam dele.

## 13. Quando capturar escrita

Evitar efeitos colaterais de persistência no hook de admissão do prompt.

A implementação deve avaliar eventos/lifecycle que representem interação concluída e usar:

- idempotency keys;
- deduplicação;
- retries limitados;
- fila local/outbox se necessário.

A escolha exata do evento deve ser confirmada contra a API V2 no momento da implementação e coberta por teste de reentrega/concorrência.

## 14. Worker Python: stdio/RPC em vez de porta fixa

O plano antigo propõe FastAPI em `localhost:8787`.

Para um plugin local, a primeira opção a testar deve ser um child process gerenciado pelo plugin com JSONL/RPC por stdin/stdout:

- sem colisão de porta;
- sem serviço TCP exposto;
- lifecycle ligado ao plugin;
- cleanup explícito;
- restart limitado;
- protocolo versionado.

Handshake candidato:

```json
{
  "protocol_version": 1,
  "schema_version": 1,
  "python_version": "3.x",
  "laya_checkpoint": "...",
  "embedding_model": "...",
  "reranker_model": "...",
  "capabilities": ["classify", "embed", "rerank"]
}
```

FastAPI pode continuar como alternativa de desenvolvimento/diagnóstico, não necessariamente como arquitetura final.

## 15. Controles de usuário e auditabilidade

O v0.1 deve expor operações claras:

- `remember` — persistência explícita;
- `search` — consulta;
- `forget` — retração/remoção conforme política;
- `explain` — mostrar por que a memória existe, fonte, escopo, status e por que foi recuperada.

A recuperação automática não deve esconder proveniência internamente. Logs de debug devem permitir reconstruir:

- query;
- filtros;
- candidatos lexical/dense;
- rank fusion;
- reranking;
- memórias descartadas;
- orçamento final de contexto.

## 16. Segurança semântica

O sistema deve distinguir confiança por origem.

Exemplo de ordem inicial a calibrar:

1. resultado determinístico de teste/tool;
2. estado real observado do repo/ambiente;
3. instrução/decisão explícita do usuário;
4. resumo derivado de múltiplas evidências;
5. afirmação do assistente não verificada.

Uma resposta passada do assistente não deve adquirir autoridade só porque foi armazenada.

Também considerar:

- dados sensíveis e secrets;
- redaction antes de persistir;
- memória por projeto sem vazamento cross-project;
- exclusão/exportação;
- paths ignorados/temporários;
- retenção específica por tipo.

## 17. Benchmark harness antes da implementação completa

Antes de congelar storage/modelos/thresholds, criar um benchmark reproduzível do caso de uso real.

### 17.1 Corpus

Meta inicial: 300-500 cenários PT/EN com:

- lembrança direta;
- preferência atualizada;
- decisão superseded;
- conflito não resolvido;
- temporalidade;
- pergunta sem resposta em memória (abstention);
- símbolos e caminhos exatos;
- SHA/issue/PR;
- erro de ferramenta;
- tentativa que falhou;
- correção validada;
- memória específica de branch;
- memória específica de projeto;
- consulta implícita;
- consulta composta/multi-facet;
- ruído semelhante semanticamente.

### 17.2 Pipelines a comparar

No mínimo:

1. dense-only;
2. BM25/FTS + dense;
3. híbrido + rank fusion + reranker;
4. híbrido + rank fusion + reranker + filtro Laya;
5. mensagem bruta vs memória atômica consolidada.

### 17.3 Modelos

Comparar:

- MiniLM atual;
- multilingual-E5-small;
- EmbeddingGemma em pelo menos duas dimensionalidades;
- reranker atual vs multilingual;
- Laya multilingual vs Router.

### 17.4 Métricas

Retrieval:

- Recall@K;
- MRR ou nDCG;
- precisão de top-K;
- taxa de memória superseded retornada.

Memória:

- precisão/recall de `should_store`;
- atualização correta;
- conflito detectado;
- duplicação;
- abstention correta.

Operação:

- p50/p95;
- cold start;
- RAM;
- disco;
- tokens injetados;
- tamanho médio do contexto;
- custo de reindexação.

### 17.5 Regra de decisão

Nenhum backend/modelo vence por reputação ou benchmark genérico. O default do plugin deve ser escolhido pelo melhor trade-off no corpus de memória de agentes de código.

## 18. Trabalhos externos que orientam a arquitetura

### LongMemEval

Mostra que memória de longo prazo deve ser testada em extração, raciocínio multi-sessão, temporalidade, knowledge updates e abstention. Também aponta ganhos com granularidade, expansão de chaves e queries conscientes de tempo.

### Mem0

Reforça a separação entre extração, consolidação e retrieval de informação saliente, em vez de simplesmente anexar histórico bruto.

### Graphiti / Zep

Demonstra valor de proveniência episódica e validade temporal. Para o v0.1 não é necessário adotar graph database, mas o schema deve preservar campos que permitam evolução temporal futura.

### A-MEM

Mostra que novas memórias podem atualizar representações de memórias antigas; isso sustenta a decisão de não tratar toda entrada como registro imutável e independente no nível derivado.

### MemGovern

Para SWE agents, transforma histórico humano bruto em experience cards estruturados. Isso sustenta `procedure` / `failure_lesson`.

### SWE-MeM

Mostra que memória em agentes de engenharia deve considerar trajetória, progresso e orçamento de contexto, não apenas regras estáticas de compressão/idade.

### LOCOMO-CONV

Mostra lacunas em consultas conversacionais implícitas e compostas que QA tradicional não revela. O benchmark do projeto deve conter esse tipo de caso e avaliar query rewriting/multi-facet.

## 19. Decisões adotadas agora

Estas decisões podem orientar o próximo design sem esperar benchmark:

1. separar evidência de memória derivada;
2. incluir proveniência;
3. modelar supersession/retraction desde o schema v1;
4. tratar escopo como dimensão independente;
5. evitar prompt hook para injeção automática;
6. usar context hook para recall efêmero;
7. suportar retrieval lexical + semântico;
8. estruturar o retrieval como streams independentes e explicáveis, aptos a incluir lexical, dense, entity e graph, com rank fusion em vez de média direta de scores heterogêneos;
9. preservar memória procedural/failure lessons;
10. manter fallback para evidência bruta quando a camada consolidada não responder adequadamente;
11. separar `kind` semântico de `tier` de retenção/uso;
12. introduzir handoff de sessão como protocolo próprio, separado de memória permanente;
13. modelar relações tipadas entre memórias/evidências sem exigir graph database no v0.1;
14. introduzir pending writes para propostas que não devem virar conhecimento canônico imediatamente;
15. permitir auto-improvement assíncrono sobre sessões concluídas, sempre atrás de gates explícitos de promoção;
16. exigir fronteira tipada de sanitização antes de qualquer persistência de texto não confiável;
17. exigir idempotência/replay seguro no pipeline de captura;
18. manter índices derivados reconstruíveis e nunca tratá-los como fonte de verdade;
19. fazer Laya atuar como kernel decisório de escrita/consolidação, não como retriever nem como autoridade sobre evidência determinística;
20. não usar Laya por candidato no recall por padrão; esse estágio só retorna se benchmark reproduzível demonstrar ganho líquido;
21. usar benchmark reproduzível como regression gate para mudanças de retrieval, consolidação e decisões do Laya;
22. tratar a implementação de `07-implementation-plan.md` como superseded até revisão.

## 20. Decisões deliberadamente adiadas

Dependem do benchmark:

- ChromaDB vs SQLite/LanceDB;
- extensão/índice vetorial;
- modelo de embedding default;
- dimensionalidade;
- reranker default;
- uso ou não de filtro Laya no recall;
- thresholds;
- top-K;
- tamanho final de contexto;
- multilingual único vs Router;
- mecanismo exato de extração;
- política de TTL.

## 21. Problemas concretos encontrados na documentação inicial

Além das decisões prematuras, há pelo menos um erro de pseudocódigo no plano antigo:

- em `07-implementation-plan.md`, `RerankRequest` é importado do FlashRank e depois redefinido como classe Pydantic com o mesmo nome; o endpoint passa a sombrear o tipo importado.

Também precisam ser revalidadas antes de implementação:

- expectativas de latência do Laya;
- claim de que English root é adequado para PT/EN;
- números de precisão/latência de embedding/reranking sem corpus reproduzível do projeto;
- hipótese de ChromaDB como solução final;
- retention fixa por idade;
- `max_memories_per_session` como limite principal;
- três collections físicas como taxonomia.

## 22. Próximo slice recomendado

Antes de escrever o pipeline completo:

1. especificar schema v1 de `EvidenceRecord`, `MemoryRecord`, `HandoffRecord` e `PendingMemoryRecord`;
2. especificar `MemoryKind`, `MemoryTier`, relações tipadas e estados de validade/supersession;
3. definir operações de consolidação e invariantes, incluindo `ADD`, `UPDATE`, `SUPERSEDE`, `NOOP`, `CONFLICT` e `REVIEW`;
4. definir escopo, precedência, autoridade de origem e regras de sanitização;
5. definir contrato de handoff com claim atômico/idempotente e consumo exatamente uma vez no nível lógico;
6. criar dataset mínimo versionado que cubra retrieval, atualização, conflito, handoff, abstention, ruído e isolamento de escopo;
7. implementar harness de benchmark isolado;
8. medir storage, retrieval, modelos e participação do Laya;
9. somente então escrever o plano de implementação v2.

O objetivo é impedir que infraestrutura seja construída em torno de escolhas ainda não demonstradas e, ao mesmo tempo, garantir que os contratos centrais não precisem de uma migração estrutural logo após a primeira implementação.

## 23. Incorporação seletiva do `ai-memory`

O projeto `akitaonrails/ai-memory` foi analisado como referência de engenharia. A decisão adotada é **não fazer fork, não usar o projeto como backend e não copiar sua arquitetura inteira**. O `opencode-memory` continuará Laya-native e preservará o modelo `evidência -> candidato -> decisão -> memória versionada`.

O objetivo é transplantar mecanismos maduros que resolvem problemas reais de memória de agentes, adaptando-os aos contratos do OpenCode e às decisões já tomadas neste documento.

### 23.1 Princípio de assimilação

Cada ideia externa deve cair em uma destas categorias:

- **adotar** — o mecanismo resolve um problema que já existe no nosso domínio e cabe diretamente na arquitetura;
- **adaptar** — o mecanismo é útil, mas precisa ser refeito em torno de Laya, OpenCode ou dos nossos contratos;
- **benchmarkar** — há hipótese forte de ganho, porém custo/qualidade ainda precisam de medição;
- **rejeitar por enquanto** — amplia escopo sem melhorar o núcleo que precisamos validar primeiro.

A existência de uma feature no `ai-memory` não é justificativa suficiente para incorporá-la.

### 23.2 Handoff é um protocolo separado de memória

Estado transitório de execução não deve ser promovido automaticamente a memória semântica durável.

O design deve introduzir `HandoffRecord` para continuidade entre sessões, contendo pelo menos, conceitualmente:

- resumo operacional;
- trabalho concluído;
- tentativas que falharam;
- perguntas/pendências abertas;
- próximos passos;
- projeto/repositório/worktree/branch;
- último estado ou commit verificado;
- owner/session de origem;
- estado de claim/consumo.

O handoff deve suportar claim atômico e idempotente. Duas sessões concorrentes não podem consumir o mesmo baton como se fossem a única sucessora.

Memórias permanentes continuam servindo para conhecimento reutilizável; handoffs servem para continuidade imediata de trabalho.

### 23.3 `kind` e `tier` são dimensões diferentes

`MemoryKind` responde **o que a memória significa**:

- preferência;
- decisão;
- fato;
- restrição;
- procedimento;
- failure lesson;
- project state;
- relação.

`MemoryTier` responde **como essa memória deve se comportar operacionalmente**:

- `working` — estado corrente e de alta volatilidade;
- `episodic` — eventos/experiências de sessões específicas;
- `semantic` — conhecimento consolidado;
- `procedural` — procedimento/experiência reutilizável.

Uma `decision` pode ser `semantic`; um `failure_lesson` pode ser `procedural`; `project_state` normalmente nasce como `working`.

Retenção, decay e promoção devem operar sobre tier + validade + confirmação, e não apenas sobre idade absoluta.

### 23.4 Relações tipadas sem exigir graph database

O schema v1 deve permitir relações explícitas entre registros, por exemplo:

- `supports`;
- `contradicts`;
- `supersedes`;
- `caused_by`;
- `fixes`;
- `depends_on`;
- `derived_from`;
- `related_to`.

A lista final deve ser pequena e fechada no primeiro schema. Relações precisam de proveniência e não podem transformar inferência do modelo em fato sem marcação.

Suportar relações não implica escolher graph database. Elas podem começar em tabelas/índices simples e ganhar uma engine de grafo apenas se o benchmark ou a complexidade real justificarem.

### 23.5 Retrieval por streams independentes

O recall deve evoluir de “lexical + dense” para um pipeline onde fontes de candidatos são independentes e explicáveis:

```text
query
  |
  +--> scope / validity / temporal filters
  |
  +--> lexical / FTS
  |
  +--> dense vectors
  |
  +--> entity matches
  |
  +--> relation/graph neighborhood
          |
          v
       rank fusion
          |
    authority/validity
          |
     optional reranker
          |
   diversity + token budget
          |
   ephemeral context
```

Nem todo stream precisa estar habilitado no default inicial. O harness deverá medir ganho marginal, custo e falsos positivos de cada stream.

A fusão deve usar uma técnica apropriada para rankings heterogêneos, como RRF, em vez de somar scores que não compartilham escala.

### 23.6 Raw-evidence fallback

Memória consolidada é uma representação derivada e pode omitir informação importante.

Quando o retrieval de memória não encontrar resposta suficiente, o sistema deve poder consultar evidências brutas dentro do escopo permitido. Esse fallback:

- não promove automaticamente a evidência a memória;
- preserva proveniência;
- respeita sanitização e retenção;
- deve ser observável no modo `explain`;
- precisa de orçamento próprio para não despejar histórico bruto no contexto.

### 23.7 Retrieval explicável

O comando/superfície `explain` deve poder reconstruir por que uma memória chegou ao contexto:

- query/facets usados;
- filtros de escopo, status e validade;
- streams que recuperaram o item;
- ranks antes/depois da fusão;
- rerank, se houve;
- autoridade/proveniência;
- versão/supersession;
- regras de diversity e orçamento;
- motivo de descarte dos candidatos imediatamente abaixo quando útil para debug.

Explicabilidade é requisito operacional e de benchmark, não apenas feature de interface.

### 23.8 Laya como kernel decisório

A incorporação das ideias do `ai-memory` reforça a separação de responsabilidades.

O Laya é adequado para decisões tipadas como:

- `should_store`;
- `kind`;
- `scope`;
- `tier`;
- temporalidade provável;
- relação provável;
- duplicata/novidade;
- `ADD | UPDATE | SUPERSEDE | NOOP | CONFLICT | REVIEW`;
- auto-accept vs pending review;
- classificação de propostas do auto-improvement.

O Laya **não** deve, por padrão:

- gerar o texto canônico da memória;
- calcular ranking lexical/dense;
- substituir rank fusion;
- rodar uma decisão separada para cada candidato de recall;
- sobrepor evidência determinística de tool/test/git;
- decidir sozinho que uma correção “funcionou”.

Se uma `procedure` ou `failure_lesson` afirma que determinada correção foi validada, essa força deve vir da evidência observada de teste/build/tool, não de confiança do modelo.

### 23.9 Pending writes e auto-improvement

Sessões concluídas podem ser analisadas fora do hot path para descobrir conhecimento útil que não foi promovido durante a interação.

Fluxo conceitual:

```text
completed session
      |
      v
isolated extractor
      |
      v
memory proposals
      |
      v
     Laya
  +---+----------------------------+
  | NOOP | AUTO_ACCEPT | SUPERSEDE |
  | CONFLICT | REVIEW              |
  +---------------+----------------+
                  |
          canonical or pending
```

Regras:

- o processo deve ser assíncrono ao fluxo de interação;
- extrator e decisão não recebem autoridade para executar tools destrutivas;
- propostas ambíguas ficam em pending;
- promoção deve manter source ids e versões;
- regras/procedimentos que dependem de sucesso técnico devem exigir evidência compatível;
- a frequência do auto-improvement permanece uma decisão operacional posterior.

### 23.10 Reinforcement e feedback

O sistema deve conseguir registrar sinais como:

- recuperada/usada;
- marcada como útil;
- marcada como irrelevante;
- confirmada novamente por evidência;
- contradita;
- substituída.

Esses sinais podem alimentar ranking, decay e revisão futura, mas não devem virar um “score mágico” acumulado indefinidamente. Pesos, janelas e normalização ficam sujeitos a benchmark para evitar viés de popularidade e feedback loops.

### 23.11 Invariantes operacionais absorvidos

Os seguintes princípios do `ai-memory` são adotados como requisitos de engenharia, adaptados ao nosso runtime:

1. persistência deve ter um caminho de escrita serializável/single-writer ou garantia transacional equivalente;
2. dado canônico e índices derivados não podem ficar em estados parcialmente atualizados após uma operação considerada concluída;
3. captura automática deve ser bounded e não bloquear o agent loop por trabalho pesado;
4. texto não confiável cruza uma fronteira explícita de sanitização antes da persistência;
5. capture/retry deve ser idempotente;
6. embeddings, FTS, entity index e relações são reconstruíveis a partir do estado canônico/evidência;
7. identidade de modelo/versão acompanha índices derivados para detectar staleness;
8. operações de reindex/rebuild não alteram a semântica canônica;
9. efeitos de contexto recuperado são efêmeros e não devem voltar ao write path como evidência nova sem origem distinguível;
10. concorrência entre sessões não pode destruir versões conflitantes nem causar consumo duplo de handoff.

A implementação concreta desses invariantes depende do backend escolhido após benchmark.

### 23.12 O que não será copiado agora

Ficam explicitamente fora do núcleo inicial:

- Markdown/wiki como source of truth canônica;
- usar `ai-memory` como backend do plugin;
- servidor compartilhado multi-user como requisito do v0.1;
- OIDC/auth ladder completa;
- grande superfície de CLI/admin;
- managed workstreams como subsistema separado;
- integrações com múltiplos harnesses que não o OpenCode;
- TTL/decay com números congelados antes de benchmark;
- graph database obrigatório;
- Laya como filtro final obrigatório de cada memória recuperada.

Esses itens podem ser revisitados quando houver necessidade observada, sem bloquear a arquitetura para evolução futura.

### 23.13 Licença e provenance

O `ai-memory` está sob licença MIT. A arquitetura pode ser estudada e ideias podem ser reimplementadas livremente.

Nossa política para esta integração é preferir **reimplementação em torno dos nossos contratos**, não cópia literal. Se algum trecho substancial de código for transplantado no futuro, o commit correspondente deve identificar a origem e preservar os avisos exigidos pela licença MIT do projeto de Fabio Akita.

A documentação deve manter o `ai-memory` creditado como referência arquitetural, sem atribuir a ele decisões que foram desenvolvidas independentemente neste projeto.

### 23.14 Consequência para o design

A arquitetura resultante permanece:

```text
OpenCode lifecycle
        |
 sanitize + dedupe
        |
 Evidence Store -------------------------------+
        |                                      |
 candidate extraction                          |
        |                                      |
       Laya                                    |
  should-store / kind / scope / tier / relation|
        |                                      |
 existing-memory lookup                        |
        |                                      |
       Laya                                    |
 ADD / UPDATE / SUPERSEDE /                    |
 NOOP / CONFLICT / REVIEW                      |
        |                                      |
 canonical versioned memory                    |
        |                                      |
  +-----+-------+---------+                    |
  | FTS | dense | entity  | relations          |
  +-----+-------+---------+                    |
        |                                      |
     rank fusion                               |
        |                                      |
 authority + validity                          |
        |                                      |
 optional reranker                             |
        |                                      |
 diversity / token budget                      |
        |                                      |
 ephemeral context                             |
                                               |
 raw-evidence fallback <-----------------------+

separate continuity path:
session end -> HandoffRecord -> atomic claim -> next-session context
```

O ponto central permanece: **Laya decide políticas e mutações; evidência determina autoridade factual; mecanismos determinísticos fazem retrieval e versionamento; o benchmark decide otimizações e defaults.**

---

## Fontes primárias e referências

### OpenCode

- Plugins V2: https://opencode.ai/v2/docs/build/plugins
- Migração V1 → V2: https://opencode.ai/v2/docs/build/plugins/migrate-v1
- Compaction: https://opencode.ai/v2/docs/compaction

### Laya

- Repositório: https://github.com/NandhaKishorM/laya
- Router: https://github.com/NandhaKishorM/laya/blob/main/laya/router.py
- Model card principal: https://huggingface.co/convaiinnovations/laya
- Multilingual: https://huggingface.co/convaiinnovations/laya-multilingual

### Retrieval / embeddings

- SQLite FTS5/BM25: https://www.sqlite.org/fts5.html
- multilingual-E5-small: https://huggingface.co/intfloat/multilingual-e5-small
- EmbeddingGemma: https://ai.google.dev/gemma/docs/embeddinggemma
- EmbeddingGemma model card: https://ai.google.dev/gemma/docs/embeddinggemma/model_card

### Memória de agentes

- ai-memory: https://github.com/akitaonrails/ai-memory
- ai-memory — arquitetura: https://github.com/akitaonrails/ai-memory/blob/main/docs/ARCHITECTURE.md
- ai-memory — invariantes operacionais: https://github.com/akitaonrails/ai-memory/blob/main/AGENTS.md
- ai-memory — benchmarks: https://github.com/akitaonrails/ai-memory/blob/main/docs/benchmarks/README.md
- ai-memory — licença MIT: https://github.com/akitaonrails/ai-memory/blob/main/LICENSE
- LongMemEval: https://arxiv.org/abs/2410.10813
- Mem0: https://arxiv.org/abs/2504.19413
- A-MEM: https://arxiv.org/abs/2502.12110
- MemGovern: https://arxiv.org/abs/2601.06789
- SWE-MeM: https://arxiv.org/abs/2606.28434
- LOCOMO-CONV: https://arxiv.org/abs/2609.03467
- Graphiti: https://github.com/getzep/graphiti
