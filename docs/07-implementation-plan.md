# Plano de Implementação

## Visão Geral

Este documento detalha o plano de implementação do plugin `opencode-memory`, cobrindo a estrutura de código, dependências, sequência de implementação e testes.

---

## Fases

### Fase 1: Setup e Infraestrutura

**Objetivo**: Estrutura básica do plugin funcionando

#### 1.1 Criar estrutura do projeto

```
opencode-memory/
├── package.json              # Dependências TypeScript
├── tsconfig.json             # Config TypeScript
├── .gitignore
├── LICENSE                   # MIT
├── README.md                 # Já criado
├── docs/                     # Já criado
├── src/
│   ├── index.ts              # Entry point do plugin
│   ├── config.ts             # Tipos e configuração
│   ├── memory/
│   │   ├── store.ts          # Armazenamento (ChromaDB wrapper)
│   │   ├── retrieve.ts       # Recuperação + reranking
│   │   ├── classify.ts       # Classificação (Laya wrapper)
│   │   └── pipeline.ts       # Pipeline orquestrador
│   ├── tools/
│   │   ├── search.ts         # Tool: search_memory
│   │   ├── store.ts          # Tool: store_memory
│   │   └── manage.ts         # Tool: list/clear memories
│   ├── hooks/
│   │   ├── prompt.ts         # Hook: prompt admission
│   │   ├── context.ts        # Hook: context enrichment
│   │   └── compaction.ts     # Hook: compaction
│   └── utils/
│       ├── python.ts         # Helper para chamar Python
│       └── logger.ts         # Logging
├── python/
│   ├── requirements.txt      # Dependências Python
│   ├── server.py             # FastAPI server
│   ├── models/
│   │   ├── __init__.py
│   │   ├── laya.py           # Wrapper Laya
│   │   ├── embedder.py       # Wrapper SentenceTransformer
│   │   └── reranker.py       # Wrapper FlashRank
│   └── tests/
│       ├── test_laya.py
│       ├── test_embedder.py
│       └── test_reranker.py
└── tests/
    ├── unit/
    │   ├── store.test.ts
    │   ├── retrieve.test.ts
    │   └── classify.test.ts
    └── integration/
        ├── pipeline.test.ts
        └── plugin.test.ts
```

#### 1.2 Dependências

**package.json**:
```json
{
  "name": "opencode-memory",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@opencode/plugin": "latest"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  }
}
```

**python/requirements.txt**:
```
laya>=0.3.5
sentence-transformers>=5.0.0
flashrank>=0.2.0
chromadb>=0.5.0
fastapi>=0.100.0
uvicorn>=0.20.0
pydantic>=2.0.0
```

---

### Fase 2: Python Server

**Objetivo**: Server Python com todos os modelos carregados

#### 2.1 Server FastAPI

```python
# python/server.py
from fastapi import FastAPI
from pydantic import BaseModel
import laya
from sentence_transformers import SentenceTransformer
from flashrank import Ranker, RerankRequest
import chromadb
import os

app = FastAPI(title="OpenCode Memory Service")

# ── Modelos ──────────────────────────────────────────────

class ClassifyRequest(BaseModel):
    text: str
    questions: dict

class ClassifyResponse(BaseModel):
    result: dict
    latency_ms: float

class EmbedRequest(BaseModel):
    texts: list[str]

class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dimensions: int
    latency_ms: float

class RerankRequest(BaseModel):
    query: str
    passages: list[dict]
    top_k: int = 5

class RerankResponse(BaseModel):
    results: list[dict]
    latency_ms: float

# ── Lifecycle ────────────────────────────────────────────

@app.on_event("startup")
async def load_models():
    global laya_agent, embedder, ranker

    print("Loading Laya...")
    laya_agent = laya.load(os.getenv("LAYA_CHECKPOINT", "convaiinnovations/laya"))

    print("Loading SentenceTransformer...")
    model_name = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    embedder = SentenceTransformer(model_name)

    print("Loading FlashRank...")
    reranker_model = os.getenv("RERANKER_MODEL", "ms-marco-MiniLM-L-12-v2")
    ranker = Ranker(model_name=reranker_model)

    print("All models loaded!")

# ── Endpoints ────────────────────────────────────────────

@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest):
    import time
    start = time.time()

    result = laya_agent.predict({"text": req.text}, req.questions)

    latency = (time.time() - start) * 1000
    return ClassifyResponse(result=result, latency_ms=latency)

@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest):
    import time
    start = time.time()

    embeddings = embedder.encode(req.texts)

    latency = (time.time() - start) * 1000
    return EmbedResponse(
        embeddings=embeddings.tolist(),
        dimensions=embeddings.shape[1],
        latency_ms=latency
    )

@app.post("/rerank", response_model=RerankResponse)
async def rerank(req: RerankRequest):
    import time
    start = time.time()

    request = RerankRequest(
        query=req.query,
        passages=req.passages
    )
    results = ranker.rerank(request)

    latency = (time.time() - start) * 1000
    return RerankResponse(results=results, latency_ms=latency)

@app.get("/health")
async def health():
    return {"status": "ok", "models_loaded": True}
```

#### 2.2 Testar server

```bash
cd python
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8787

# Testar
curl -X POST http://localhost:8787/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "O usuário prefere TypeScript", "questions": {"type": {"type": "choice", "instructions": "Tipo?", "criteria": {"preference": "Preferência", "fact": "Fato"}}}}'
```

---

### Fase 3: Plugin TypeScript Core

**Objetivo**: Plugin OpenCode funcionando com storage e tools básicas

#### 3.1 Entry point

```typescript
// src/index.ts
import { Plugin } from "@opencode/plugin"
import { MemoryPipeline } from "./memory/pipeline"
import { registerTools } from "./tools"
import { registerHooks } from "./hooks"

export default Plugin.define({
  id: "opencode-memory",

  async setup(ctx) {
    // ── Config ──────────────────────────────────────
    const config = {
      enabled: ctx.options.enabled !== false,
      embeddingModel: (ctx.options.embedding_model as string) || "all-MiniLM-L6-v2",
      rerankerModel: (ctx.options.reranker_model as string) || "ms-marco-MiniLM-L-12-v2",
      layaCheckpoint: (ctx.options.laya_checkpoint as string) || "convaiinnovations/laya",
      maxMemories: (ctx.options.max_memories_per_session as number) || 50,
      importanceThreshold: (ctx.options.importance_threshold as string) || "média",
      pythonPort: (ctx.options.python_server_port as number) || 8787,
    }

    if (!config.enabled) {
      console.log("[memory] Plugin disabled")
      return
    }

    // ── Pipeline ────────────────────────────────────
    const pipeline = new MemoryPipeline(config)

    // ── Storage init ────────────────────────────────
    await ctx.storage.set("config", config)
    await ctx.storage.set("initialized", true)

    // ── Register tools ──────────────────────────────
    await registerTools(ctx, pipeline)

    // ── Register hooks ──────────────────────────────
    await registerHooks(ctx, pipeline)

    console.log("[memory] Plugin initialized")

    // ── Cleanup ─────────────────────────────────────
    return () => {
      console.log("[memory] Plugin unloaded")
    }
  },
})
```

#### 3.2 Pipeline

```typescript
// src/memory/pipeline.ts
import { PythonClient } from "../utils/python"
import { MemoryEntry, QueryResult, Classification } from "../config"

export class MemoryPipeline {
  private python: PythonClient
  private config: any

  constructor(config: any) {
    this.config = config
    this.python = new PythonClient(config.pythonPort)
  }

  async store(text: string, metadata: Record<string, any>): Promise<string> {
    // 1. Classificar com Laya
    const classification = await this.classify(text)

    // 2. Verificar se deve armazenar
    if (!classification.should_store) {
      return null
    }

    // 3. Gerar embedding
    const embedding = await this.embed(text)

    // 4. Inserir no ChromaDB (via Python)
    const id = await this.python.storeMemory({
      text,
      embedding,
      metadata: {
        ...metadata,
        type: classification.type,
        importance: classification.importance,
      },
    })

    return id
  }

  async recall(query: string, limit: number = 5): Promise<QueryResult[]> {
    // 1. Embedding da query
    const queryEmbedding = await this.embed(`query: ${query}`)

    // 2. Buscar top-20 no ChromaDB
    const candidates = await this.python.searchMemory({
      embedding: queryEmbedding,
      limit: this.config.top_k_retrieval || 20,
    })

    // 3. Rerank com FlashRank
    const reranked = await this.python.rerank({
      query,
      passages: candidates,
      top_k: limit,
    })

    // 4. Filtrar com Laya
    const filtered = await this.filterWithLaya(query, reranked)

    return filtered
  }

  private async classify(text: string): Promise<Classification> {
    const result = await this.python.classify({
      text,
      questions: {
        type: {
          type: "choice",
          instructions: "Classifique o tipo de informação:",
          criteria: {
            decision: "Decisão técnica",
            preference: "Preferência do usuário",
            fact: "Fato sobre o projeto",
          },
        },
        importance: {
          type: "score",
          instructions: "Importância para longo prazo?",
          criteria: ["baixa", "média", "alta"],
        },
        should_store: {
          type: "noul",
          instructions: "Vale a pena armazenar?",
          criteria: {
            true: "Informação reutilizável",
            false: "Genérica ou temporária",
          },
        },
      },
    })

    return {
      type: result.type,
      importance: result.importance,
      should_store: result.should_store,
    }
  }

  private async embed(text: string): Promise<number[]> {
    const result = await this.python.embed([text])
    return result.embeddings[0]
  }

  private async filterWithLaya(
    query: string,
    candidates: any[]
  ): Promise<QueryResult[]> {
    const filtered = []

    for (const candidate of candidates) {
      const result = await this.python.classify({
        text: `${candidate.text} | Query: ${query}`,
        questions: {
          relevance: {
            type: "noul",
            instructions: `Esta memória é relevante para: "${query}"?`,
            criteria: {
              true: "Relevante",
              false: "Não relevante",
            },
          },
        },
      })

      if (result.relevance) {
        filtered.push({
          entry: candidate,
          similarity_score: candidate.score,
          rerank_score: candidate.rerank_score,
          laya_relevant: true,
          final_score: (candidate.score + candidate.rerank_score) / 2,
        })
      }
    }

    return filtered.slice(0, this.config.top_k_final || 5)
  }
}
```

#### 3.3 Python Client

```typescript
// src/utils/python.ts
export class PythonClient {
  private baseUrl: string

  constructor(port: number) {
    this.baseUrl = `http://localhost:${port}`
  }

  async classify(input: { text: string; questions: any }): Promise<any> {
    const res = await fetch(`${this.baseUrl}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    return res.json()
  }

  async embed(texts: string[]): Promise<{ embeddings: number[][] }> {
    const res = await fetch(`${this.baseUrl}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
    })
    return res.json()
  }

  async rerank(input: {
    query: string
    passages: any[]
    top_k: number
  }): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    const data = await res.json()
    return data.results
  }

  async storeMemory(input: {
    text: string
    embedding: number[]
    metadata: any
  }): Promise<string> {
    // TODO: implementar via ChromaDB direto ou endpoint
    const res = await fetch(`${this.baseUrl}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    return res.json()
  }

  async searchMemory(input: {
    embedding: number[]
    limit: number
  }): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    return res.json()
  }
}
```

---

### Fase 4: Tools do Plugin

**Objetivo**: Tools que o agente pode usar

#### 4.1 search_memory

```typescript
// src/tools/search.ts
export function registerSearchTool(ctx: any, pipeline: any) {
  return ctx.tool.transform((editor: any) => {
    editor.namespace({
      name: "memory",
      description: "Long-term memory system",
    })

    editor.add({
      name: "search_memory",
      description: "Search long-term memory for relevant past information. Use this to recall previous decisions, preferences, and facts.",
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for in memory",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 5)",
          },
        },
        required: ["query"],
      },
      options: { namespace: "memory", codemode: true },
      execute: async (input: any, context: any) => {
        const { query, limit = 5 } = input

        await context.progress({ status: "Searching memory..." })

        const results = await pipeline.recall(query, limit)

        if (results.length === 0) {
          return { content: "No relevant memories found." }
        }

        const formatted = results
          .map((r: any, i: number) =>
            `[${i + 1}] (${r.final_score.toFixed(2)}) ${r.entry.content}`
          )
          .join("\n")

        return {
          content: `Found ${results.length} relevant memories:\n\n${formatted}`,
        }
      },
    })
  })
}
```

#### 4.2 store_memory

```typescript
// src/tools/store.ts
export function registerStoreTool(ctx: any, pipeline: any) {
  return ctx.tool.transform((editor: any) => {
    editor.add({
      name: "store_memory",
      description: "Store important information in long-term memory for future recall.",
      input: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The information to remember",
          },
          type: {
            type: "string",
            enum: ["fact", "preference", "decision"],
            description: "Type of memory",
          },
        },
        required: ["content"],
      },
      options: { namespace: "memory", codemode: true },
      execute: async (input: any, context: any) => {
        const { content, type = "fact" } = input

        await context.progress({ status: "Storing memory..." })

        const id = await pipeline.store(content, {
          type,
          source: "agent",
          timestamp: Date.now(),
        })

        if (id) {
          return { content: `Memory stored successfully. ID: ${id}` }
        } else {
          return { content: "Memory was not stored (low importance or duplicate)." }
        }
      },
    })
  })
}
```

---

### Fase 5: Hooks

**Objetivo**: Integração automática com sessões

#### 5.1 Prompt Hook

```typescript
// src/hooks/prompt.ts
export function registerPromptHook(ctx: any, pipeline: any) {
  ctx.session.hook("prompt", async (event: any) => {
    // Buscar memórias relevantes para o prompt do usuário
    const memories = await pipeline.recall(event.prompt.text, 3)

    if (memories.length > 0) {
      const memoryBlock = memories
        .map((m: any) => `  - ${m.entry.content}`)
        .join("\n")

      // Injetar no início do prompt
      event.prompt.text =
        `[Long-term memory context]\n${memoryBlock}\n[End of memory]\n\n${event.prompt.text}`
    }
  })
}
```

#### 5.2 Context Hook

```typescript
// src/hooks/context.ts
export function registerContextHook(ctx: any) {
  ctx.session.hook("context", (event: any) => {
    // Adicionar instrução sobre memória
    event.system.push({
      type: "text",
      text: [
        "## Long-term Memory",
        "You have access to a long-term memory system.",
        "Use the `memory_search_memory` tool to recall past decisions, preferences, and facts.",
        "Use the `memory_store_memory` tool to save important information for future sessions.",
        "Memories are automatically injected at the start of each conversation.",
      ].join("\n"),
    })
  })
}
```

---

### Fase 6: Testes

**Objetivo**: Cobertura de testes para componentes críticos

#### 6.1 Testes Python

```python
# python/tests/test_laya.py
import pytest
from models.laya import LayaClassifier

@pytest.fixture
def classifier():
    return LayaClassifier()

def test_classify_decision(classifier):
    result = classifier.classify(
        "Decidimos usar PostgreSQL ao invés de MongoDB",
        questions={
            "type": {"type": "choice", "instructions": "Tipo?",
                     "criteria": {"decision": "Decisão", "preference": "Preferência"}}
        }
    )
    assert result["type"] == "decision"

def test_classify_importance(classifier):
    result = classifier.classify(
        "O usuário sempre prefere TypeScript",
        questions={
            "importance": {"type": "score", "instructions": "Importância?",
                          "criteria": ["baixa", "média", "alta"]}
        }
    )
    assert result["importance"] in ["baixa", "média", "alta"]
```

#### 6.2 Testes TypeScript

```typescript
// tests/unit/store.test.ts
import { describe, it, expect } from "vitest"
import { MemoryStore } from "../../src/memory/store"

describe("MemoryStore", () => {
  it("should store and retrieve memory", async () => {
    const store = new MemoryStore({ path: ":memory:" })

    const id = await store.add({
      content: "Test memory",
      embedding: [0.1, 0.2, 0.3],
      metadata: { type: "fact" },
    })

    expect(id).toBeDefined()

    const results = await store.search([0.1, 0.2, 0.3], 1)
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe("Test memory")
  })
})
```

---

## Ordem de Implementação

| # | Tarefa | Depende de | Esforço |
|---|--------|------------|---------|
| 1 | Estrutura do projeto | Nada | 1h |
| 2 | Python server (FastAPI) | Nada | 4h |
| 3 | Testar Python server | #2 | 1h |
| 4 | Plugin entry point + config | #1 | 2h |
| 5 | PythonClient (TS) | #4 | 2h |
| 6 | MemoryPipeline | #5 | 6h |
| 7 | Tools: search_memory | #6 | 2h |
| 8 | Tools: store_memory | #6 | 2h |
| 9 | Hooks: prompt + context | #6 | 3h |
| 10 | Testes Python | #2 | 3h |
| 11 | Testes TypeScript | #6-9 | 4h |
| 12 | Documentação de uso | #1-11 | 2h |
| **Total** | | | **~32h** |

---

## Riscos e Mitigações

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Python server não inicia | Plugin infuncional | Health check + retry logic |
| Latência do Laya alta | Lento para recalls | Cache de classificações |
| ChromaDB corrompido | Perda de memórias | Backup automático |
| Memória do Python alta | OOM em máquinas pequenas | Lazy loading dos modelos |
| Laya classifica mal | Memórias irrelevantes armazenadas | Threshold ajustável + revisão |

---

## Próximos Passos Imediatos

1. Criar `package.json` e `tsconfig.json`
2. Instalar dependências Python (`pip install -r requirements.txt`)
3. Implementar `python/server.py`
4. Testar server com curl
5. Criar `src/index.ts` básico
6. Testar plugin no OpenCode
