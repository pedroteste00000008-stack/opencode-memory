# Arquitetura do Plugin de Memória

## Visão Geral

O plugin opencode-memory é composto por 4 componentes principais coordenados por um pipeline central. Cada componente tem uma responsabilidade bem definida e pode ser trocado independentemente.

---

## Diagrama de Componentes

```
                    ┌─────────────────────────────────┐
                    │         OpenCode Server           │
                    │                                    │
                    │  ┌──────────┐   ┌──────────┐     │
                    │  │ Session  │   │  Plugin   │     │
                    │  │  Hooks   │──▶│  Context  │     │
                    │  └──────────┘   └─────┬────┘     │
                    └───────────────────────┼───────────┘
                                            │
                    ┌───────────────────────▼───────────┐
                    │        Memory Pipeline             │
                    │                                     │
                    │  ┌─────────────────────────────┐   │
                    │  │      Orchestrator            │   │
                    │  │  (coordena store/recall/     │   │
                    │  │   prune)                     │   │
                    │  └─────┬───────┬───────┬───────┘   │
                    │        │       │       │            │
                    └────────┼───────┼───────┼────────────┘
                             │       │       │
              ┌──────────────▼─┐ ┌───▼───┐ ┌─▼──────────────┐
              │    Laya        │ │Embed  │ │   Reranker     │
              │  (Decision)    │ │der    │ │  (FlashRank)   │
              │                │ │(ST)   │ │                │
              │ • Classificar  │ │       │ │ • Reordenar    │
              │ • Decidir      │ │ • 384d│ │ • Cross-enc    │
              │   armazenar    │ │ • CPU │ │ • ~34MB        │
              │ • Filtrar      │ │       │ │                │
              └────────┬───────┘ └───┬───┘ └───────┬────────┘
                       │             │              │
                       └──────┬──────┘──────────────┘
                              │
                    ┌─────────▼─────────┐
                    │     ChromaDB       │
                    │   (Vector Store)   │
                    │                    │
                    │  ┌──────────────┐  │
                    │  │ facts        │  │
                    │  │ conversations│  │
                    │  │ decisions    │  │
                    │  └──────────────┘  │
                    └────────────────────┘
```

---

## Fluxos de Dados

### 1. Fluxo de Armazenamento (Store)

Quando uma nova mensagem é processada:

```
Mensagem do usuário/assistente
        │
        ▼
┌───────────────────┐
│ 1. Capturar texto  │
│    + metadata      │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐     ┌──────────────────┐
│ 2. Laya classifica│────▶│ Perguntas:       │
│    - tipo?        │     │ - choice: tipo   │
│    - importância? │     │ - score: import. │
│    - armazenar?   │     │ - noul: relevante│
└─────────┬─────────┘     └──────────────────┘
          │
          ▼ (se importance >= threshold)
┌───────────────────┐
│ 3. Gerar embedding│
│    (384 dimensões) │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ 4. Inserir no     │
│    ChromaDB        │
│    com metadata    │
└───────────────────┘
```

### 2. Fluxo de Recuperação (Recall)

Quando o contexto está sendo montado para uma requisição:

```
Mensagem atual do usuário
        │
        ▼
┌───────────────────┐
│ 1. Gerar embedding│
│    da query        │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ 2. ChromaDB:      │
│    cosine search   │
│    top-20          │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐     ┌──────────────────┐
│ 3. FlashRank:     │────▶│ Cross-encoder    │
│    rerank top-20  │     │ ~34MB, <100ms    │
│    → top-5        │     │                  │
└─────────┬─────────┘     └──────────────────┘
          │
          ▼
┌───────────────────┐     ┌──────────────────┐
│ 4. Laya filtra    │────▶│ Pergunta:        │
│    obsoletos      │     │ noul: "relevante │
│    e irrelevantes │     │  para query atual"│
└─────────┬─────────┘     └──────────────────┘
          │
          ▼
┌───────────────────┐
│ 5. Injetar top-3  │
│    no system      │
│    prompt          │
└───────────────────┘
```

### 3. Fluxo de Limpeza (Prune)

Executado periodicamente (ex: a cada 24h ou manualmente):

```
┌───────────────────┐
│ 1. Listar memórias│
│    antigas (>30d)  │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐     ┌──────────────────┐
│ 2. Laya revisa    │────▶│ "Esta memória    │
│    cada memória   │     │  ainda é válida?" │
│                   │     │ noul: true/false  │
└─────────┬─────────┘     └──────────────────┘
          │
          ▼ (se obsoleta ou conflitante)
┌───────────────────┐
│ 3. Marcar/remover │
│    do ChromaDB     │
└───────────────────┘
```

---

## Formato dos Dados

### MemoryEntry

```typescript
interface MemoryEntry {
  id: string                          // UUID único
  collection: CollectionName          // facts | conversations | decisions
  content: string                     // Texto original armazenado
  embedding: Float32Array             // 384 dimensões (MiniLM)
  metadata: MemoryMetadata
  laya_classification: LayaResult
}

type CollectionName = "facts" | "conversations" | "decisions"

interface MemoryMetadata {
  sessionID: string                   // Sessão OpenCode de origem
  timestamp: number                   // Unix timestamp (ms)
  type: string                        // Classificado pelo Laya
  importance: "baixa" | "média" | "alta"
  project?: string                    // Diretório do projeto
  tags?: string[]                     // Tags automáticas
  source: "user" | "assistant" | "system"
}

interface LayaResult {
  type_label: string
  type_confidence: number             // 0-1
  importance_score: number            // 0-1
  is_relevant: boolean
  raw: object                         // Resposta crua do Laya
}
```

### QueryResult

```typescript
interface QueryResult {
  entry: MemoryEntry
  similarity_score: number            // Cosine similarity do ChromaDB
  rerank_score: number                // Score do FlashRank
  laya_relevant: boolean              // Filtrado pelo Laya
  final_score: number                 // Score combinado
}
```

---

## Decisões de Design

### 1. Por que 3 collection separadas?

| Collection | Conteúdo | Retenção | Importância |
|-----------|----------|----------|-------------|
| `facts` | Preferências, configurações, decisões técnicas | Indefinida | Alta |
| `conversations` | Resumos de conversas passadas | 90 dias | Média |
| `decisions` | Decisões de arquitetura/design | Indefinida | Alta |

Isso permite:
- Busca mais precisa (não misturar contextos)
- Políticas de retenção diferentes
- Laya pode usar o tipo da collection no contexto

### 2. Por que Laya em vez de LLM para classificação?

- **Velocidade**: ~33ms vs ~500ms+ (LLM)
- **Custo**: $0 self-hosted vs API calls
- **Calibração**: Probabilidades matematicamente calibradas
- **Consistência**: Não gera texto, não tem alucinações
- **Offline**: Funciona sem internet

### 3. Por que FlashRank em vez de Sentence Transformers CrossEncoder?

- **Leveza**: ~34MB vs ~80MB+
- **Velocidade**: Não precisa de PyTorch (usa ONNX)
- **Simplicidade**: `pip install flashrank` e pronto
- **Performance**: Competitivo com cross-encoders maiores

### 4. Por que ChromaDB em vez de FAISS puro?

- **Praticidade**: CRUD completo, persistência automática
- **Filtros**: Metadata filtering embutido
- **Simples**: Zero config, roda in-process
- **Performance suficiente**: Até ~1M documentos OK

---

## Limits e Trade-offs

| Limite | Valor | Justificativa |
|--------|-------|---------------|
| Max tokens por memória | 512 | Limite do Laya English checkpoint |
| Embedding dimensions | 384 | all-MiniLM-L6-v2 |
| Top-K retrieval | 20 | Balance recall vs latency |
| Top-K final | 3 | Não poluir contexto |
| Max memórias/sessão | 50 | Evitar overhead |
| Retenção facts | ∞ | Informação permanente |
| Retenção conversations | 90d | Conversas ficam obsoletas |
| Retention decisions | ∞ | Decisões são importantes |
| Importance threshold | média | Não armazenar ruído |
