/**
 * Plugin configuration (v1, revised architecture).
 *
 * Nothing here freezes benchmark-dependent choices: storage backend,
 * embedding / reranker models, thresholds and top-K stay provisional
 * until the reproducible benchmark harness decides (docs/08 §17, §20).
 */

export type StorageBackend = "sqlite" | "lancedb" | "chromadb"

export interface MemoryPluginConfig {
  enabled: boolean
  /** Provisional default; benchmark decides the final default. */
  storageBackend: StorageBackend
  /** Provisional candidates, not frozen. */
  embeddingModel: string
  rerankerModel: string | null
  layaCheckpoint: string
  /** Python worker transport: stdio/RPC preferred, TCP only for dev/diag. */
  pythonTransport: "stdio" | "tcp"
  pythonPort: number
  maxMemoriesPerSession: number
  topKRetrieval: number
  topKFinal: number
  /** Max tokens injected as ephemeral memory context. */
  maxContextTokens: number
  /** Data directory (canonical store + derived indexes). */
  dataDir: string
}

export const DEFAULT_CONFIG: MemoryPluginConfig = {
  enabled: true,
  storageBackend: "sqlite",
  embeddingModel: "intfloat/multilingual-e5-small",
  rerankerModel: null, // optional until benchmark proves net gain
  layaCheckpoint: "convaiinnovations/laya-multilingual",
  pythonTransport: "stdio",
  pythonPort: 8787,
  maxMemoriesPerSession: 50,
  topKRetrieval: 20,
  topKFinal: 5,
  maxContextTokens: 2000,
  dataDir: "./.opencode/memory",
}

export function resolveConfig(
  options: Record<string, unknown>,
): MemoryPluginConfig {
  const pick = <T>(key: string, fallback: T): T => {
    const v = options[key]
    return (v === undefined || v === null ? fallback : v) as T
  }
  const storageBackend = pick("storage_backend", DEFAULT_CONFIG.storageBackend)
  if (!["sqlite", "lancedb", "chromadb"].includes(storageBackend as string)) {
    throw new Error(`[memory] invalid storage_backend: ${storageBackend}`)
  }
  const pythonTransport = pick("python_transport", DEFAULT_CONFIG.pythonTransport)
  if (!["stdio", "tcp"].includes(pythonTransport as string)) {
    throw new Error(`[memory] invalid python_transport: ${pythonTransport}`)
  }
  const topKRetrieval = pick("top_k_retrieval", DEFAULT_CONFIG.topKRetrieval)
  const topKFinal = pick("top_k_final", DEFAULT_CONFIG.topKFinal)
  if (topKFinal > topKRetrieval) {
    throw new Error(
      "[memory] top_k_final must be <= top_k_retrieval",
    )
  }
  return {
    enabled: pick("enabled", DEFAULT_CONFIG.enabled),
    storageBackend: storageBackend as StorageBackend,
    embeddingModel: pick("embedding_model", DEFAULT_CONFIG.embeddingModel),
    rerankerModel: pick("reranker_model", DEFAULT_CONFIG.rerankerModel),
    layaCheckpoint: pick("laya_checkpoint", DEFAULT_CONFIG.layaCheckpoint),
    pythonTransport: pythonTransport as "stdio" | "tcp",
    pythonPort: pick("python_server_port", DEFAULT_CONFIG.pythonPort),
    maxMemoriesPerSession: pick(
      "max_memories_per_session",
      DEFAULT_CONFIG.maxMemoriesPerSession,
    ),
    topKRetrieval: topKRetrieval as number,
    topKFinal: topKFinal as number,
    maxContextTokens: pick("max_context_tokens", DEFAULT_CONFIG.maxContextTokens),
    dataDir: pick("data_dir", DEFAULT_CONFIG.dataDir),
  }
}
