# Pesquisa: API de Plugins do OpenCode V2

## Visão Geral

Plugins do OpenCode V2 são módulos TypeScript que estendem o comportamento do servidor. Eles podem:
- Interceptar e modificar prompts
- Adicionar tools customizadas
- Transformar providers e models
- Registrar hooks em sessões
- Armazenar dados persistentes

**Documentação oficial**: https://opencode.ai/v2/docs/build/plugins

---

## Estrutura Básica de um Plugin

```typescript
// .opencode/plugins/memory/index.ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "memory",

  async setup(ctx) {
    // ctx é o contexto do plugin (server client + métodos extras)

    console.log(`Memory plugin loaded in OpenCode ${ctx.app.version}`)
    console.log(`Directory: ${ctx.location.directory}`)

    // Ler opções do plugin
    const enabled = ctx.options.enabled !== false

    // Armazenar dados persistentes
    await ctx.storage.set("initialized", true)

    // Cleanup function (opcional)
    return () => {
      console.log("Memory plugin unloaded")
    }
  },
})
```

---

## Capacidades do Plugin Context

### 1. Storage (Persistência)

```typescript
// Armazenar dados
await ctx.storage.set("config", { enabled: true, threshold: 0.5 })
await ctx.storage.set("cache/query123", { results: [...] })

// Ler dados
const config = await ctx.storage.get("config")

// Deletar
await ctx.storage.remove("cache/query123")

// Scan por prefixo
const page = await ctx.storage.scan({ prefix: "cache/", limit: 100 })
// page.entries = [{ key: "cache/query123", value: {...} }]
// page.next = "cursor_for_next_page" ou null
```

### 2. Tools (Ferramentas customizadas)

```typescript
// Registrar tools que o agente pode usar
await ctx.tool.transform((editor) => {
  // Namespace para agrupar
  editor.namespace({
    name: "memory",
    description: "Memory tools for long-term knowledge",
  })

  // Tool de busca na memória
  editor.add({
    name: "search_memory",
    description: "Search long-term memory for relevant past information",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results", default: 5 },
      },
      required: ["query"],
    },
    options: { namespace: "memory", codemode: true },
    execute: async (input, context) => {
      const { query, limit } = input as { query: string; limit: number }

      // Chamar Python script para buscar na memória
      const results = await searchMemory(query, limit)

      return {
        content: JSON.stringify(results, null, 2),
      }
    },
  })

  // Tool de armazenamento
  editor.add({
    name: "store_memory",
    description: "Store information in long-term memory",
    input: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to store" },
        type: {
          type: "string",
          enum: ["fact", "preference", "decision"],
          description: "Memory type",
        },
      },
      required: ["content"],
    },
    options: { namespace: "memory", codemode: true },
    execute: async (input, context) => {
      const { content, type } = input as { content: string; type: string }

      const id = await storeMemory(content, type)

      return {
        content: `Memory stored successfully. ID: ${id}`,
      }
    },
  })
})
```

### 3. Session Hooks

#### Prompt Admission (antes de admitir prompt)

```typescript
// Interceptar prompts do usuário
await ctx.session.hook("prompt", (event) => {
  // event.prompt.text = texto do usuário
  // event.prompt.files = arquivos anexados

  // Adicionar memórias relevantes ao contexto
  const memories = searchMemorySync(event.prompt.text)
  if (memories.length > 0) {
    const memoryContext = memories
      .map(m => `- ${m.content}`)
      .join("\n")

    // Injetar no início do prompt
    event.prompt.text = `[Memórias relevantes]\n${memoryContext}\n\n[Fim das memórias]\n\n${event.prompt.text}`
  }
})
```

#### Context Hook (antes de cada chamada ao modelo)

```typescript
// Modificar system instructions
await ctx.session.hook("context", (event) => {
  // event.system = array de system messages
  // event.messages = histórico de mensagens
  // event.tools = tools disponíveis

  // Adicionar instrução sobre memória
  event.system.push({
    type: "text",
    text: "Você tem acesso a memórias de longo prazo. Use a tool memory_search_memory para buscar informações relevantes de conversas passadas.",
  })
})
```

#### Compaction Hook (durante sumarização)

```typescript
// Resumir memórias importantes durante compaction
await ctx.session.hook("compaction", async (event) => {
  // Extrair informações importantes do histórico
  const importantInfo = extractImportantInfo(event.messages)

  // Armazenar como nova memória
  for (const info of importantInfo) {
    await storeMemory(info.text, info.type)
  }
})
```

### 4. Commands (Comandos de usuário)

```typescript
// Registrar comando /memory
await ctx.command.transform((editor) => {
  editor.add({
    name: "memory",
    description: "Manage long-term memory",
    execute: async ({ sessionID, prompt, delivery }) => {
      // Parse arguments
      const args = prompt.text.split(" ")
      const subcommand = args[1] // list, search, clear, etc.

      switch (subcommand) {
        case "list":
          const memories = await listMemories()
          await ctx.session.synthetic({
            sessionID,
            text: `Memórias armazenadas:\n${memories.map(m => `- ${m.content}`).join("\n")}`,
          })
          break

        case "search":
          const query = args.slice(2).join(" ")
          const results = await searchMemory(query)
          await ctx.session.synthetic({
            sessionID,
            text: `Resultados para "${query}":\n${results.map(r => `- ${r.content} (score: ${r.score})`).join("\n")}`,
          })
          break

        case "clear":
          await clearAllMemories()
          await ctx.session.synthetic({
            sessionID,
            text: "Todas as memórias foram limpas.",
          })
          break
      }
    },
  })
})
```

### 5. Event Subscription

```typescript
// Escutar eventos do servidor
const controller = new AbortController()

void (async () => {
  for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
    switch (event.type) {
      case "session.created":
        // Nova sessão — preparar contexto de memória
        break

      case "session.message":
        // Nova mensagem — potencialmente armazenar
        break

      case "session.compacted":
        // Compaction ocorreu — revisar memórias
        break
    }
  }
})()

// Cleanup
return () => controller.abort()
```

### 6. Generate (gerar texto sem sessão)

```typescript
// Usar LLM para resumir memórias
const summary = await ctx.generate.text({
  model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
  prompt: "Resuma estas memórias em 3-5 pontos principais:\n\n" +
    memories.map(m => m.content).join("\n"),
})
```

---

## Integração com Python

Como o plugin é TypeScript mas os modelos (Laya, SentenceTransformer, FlashRank) são Python, temos duas opções:

### Opção 1: Shell Scripts (simples)

```typescript
// Chamar script Python via shell
async function classifyMemory(text: string): Promise<Classification> {
  const result = await Bun.spawn([
    "python3",
    "-c",
    `
import laya, json
agent = laya.load("convaiinnovations/laya")
result = agent.predict({"text": """${text}"""}, {
    "type": {"type": "choice", "instructions": "...", "criteria": {...}},
    "importance": {"type": "score", "instructions": "...", "criteria": [...]}
})
print(json.dumps(result))
    `
  ]).stdout.text()

  return JSON.parse(result)
}
```

### Opção 2: FastAPI Server (recomendado para produção)

```python
# python/server.py
from fastapi import FastAPI
from pydantic import BaseModel
import laya
from sentence_transformers import SentenceTransformer
from flashrank import Ranker

app = FastAPI()

# Carregar modelos na inicialização
laya_agent = laya.load("convaiinnovations/laya")
embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
ranker = Ranker(model_name="ms-marco-MiniLM-L-12-v2")

class ClassifyRequest(BaseModel):
    text: str

class EmbedRequest(BaseModel):
    texts: list[str]

class RerankRequest(BaseModel):
    query: str
    passages: list[dict]

@app.post("/classify")
async def classify(req: ClassifyRequest):
    result = laya_agent.predict(
        {"text": req.text},
        {
            "type": {"type": "choice", "instructions": "...", "criteria": {...}},
            "importance": {"type": "score", "instructions": "...", "criteria": [...]}
        }
    )
    return result

@app.post("/embed")
async def embed(req: EmbedRequest):
    embeddings = embedder.encode(req.texts)
    return {"embeddings": embeddings.tolist()}

@app.post("/rerank")
async def rerank(req: RerankRequest):
    from flashrank import RerankRequest as RR
    request = RR(query=req.query, passages=req.passages)
    results = ranker.rerank(request)
    return {"results": results}
```

```typescript
// Plugin TypeScript chama o server Python
async function classifyMemory(text: string): Promise<Classification> {
  const response = await fetch("http://localhost:8787/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  return response.json()
}
```

---

## Configuração do Plugin

### opencode.jsonc

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  "plugins": [
    {
      "package": "./plugins/memory",
      "options": {
        "enabled": true,

        // Modelos
        "embedding_model": "all-MiniLM-L6-v2",
        "reranker_model": "ms-marco-MiniLM-L-12-v2",
        "laya_checkpoint": "convaiinnovations/laya",

        // Comportamento
        "max_memories_per_session": 50,
        "importance_threshold": "média",
        "collection_prefix": "opencode",

        // Python server
        "python_server_port": 8787,
        "python_server_host": "localhost",

        // Limits
        "max_tokens_per_memory": 512,
        "top_k_retrieval": 20,
        "top_k_final": 5
      }
    }
  ]
}
```

### Leitura das opções no plugin

```typescript
export default Plugin.define({
  id: "memory",

  async setup(ctx) {
    const config = {
      enabled: ctx.options.enabled !== false,
      embeddingModel: (ctx.options.embedding_model as string) || "all-MiniLM-L6-v2",
      rerankerModel: (ctx.options.reranker_model as string) || "ms-marco-MiniLM-L-12-v2",
      layaCheckpoint: (ctx.options.laya_checkpoint as string) || "convaiinnovations/laya",
      maxMemories: (ctx.options.max_memories_per_session as number) || 50,
      importanceThreshold: (ctx.options.importance_threshold as string) || "média",
      pythonPort: (ctx.options.python_server_port as number) || 8787,
    }

    // Usar config...
  },
})
```

---

## Lifecycle

```
1. OpenCode carrega plugin
2. setup() é chamado com ctx
3. Plugin registra transforms, hooks, tools
4. Plugin pode retornar cleanup function
5. Quando OpenCode descarrega plugin, cleanup é chamado
```

### Erros durante setup

- Se setup() throw, o plugin não é carregado
- Outros plugins continuam normalmente
- Erro é logado no OpenCode log

---

## Fontes

- **Plugins Guide**: https://opencode.ai/v2/docs/build/plugins
- **CLI Plugin Guide**: https://opencode.ai/v2/docs/build/plugins/cli
- **RPC Guide**: https://opencode.ai/v2/docs/build/plugins/rpc
- **Config**: https://opencode.ai/v2/docs/config
