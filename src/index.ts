/**
 * opencode-memory - Long-term memory plugin for OpenCode
 *
 * Uses Laya (decision engine) + Sentence Transformers (embeddings)
 * + FlashRank (reranking) + ChromaDB (vector store)
 *
 * @package opencode-memory
 * @license MIT
 */

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-memory",

  async setup(ctx) {
    // ── Configuration ─────────────────────────────
    const config = {
      enabled: (ctx.options.enabled as boolean) ?? true,
      embeddingModel: (ctx.options.embedding_model as string) ?? "all-MiniLM-L6-v2",
      rerankerModel: (ctx.options.reranker_model as string) ?? "ms-marco-MiniLM-L-12-v2",
      layaCheckpoint: (ctx.options.laya_checkpoint as string) ?? "convaiinnovations/laya",
      maxMemories: (ctx.options.max_memories_per_session as number) ?? 50,
      importanceThreshold: (ctx.options.importance_threshold as string) ?? "média",
      pythonPort: (ctx.options.python_server_port as number) ?? 8787,
    }

    if (!config.enabled) {
      console.log("[memory] Plugin disabled via configuration")
      return
    }

    // ── Initialize ────────────────────────────────
    console.log("[memory] Initializing OpenCode Memory Plugin")
    console.log(`[memory] Embedding model: ${config.embeddingModel}`)
    console.log(`[memory] Reranker model: ${config.rerankerModel}`)
    console.log(`[memory] Laya checkpoint: ${config.layaCheckpoint}`)
    console.log(`[memory] Python server: localhost:${config.pythonPort}`)

    // ── Storage ───────────────────────────────────
    await ctx.storage.set("config", config)
    await ctx.storage.set("initialized", true)
    await ctx.storage.set("stats", {
      totalMemories: 0,
      lastStore: null,
      lastRecall: null,
    })

    // ── Register tools ────────────────────────────
    // TODO: Implement tools (Phase 4)
    // await registerTools(ctx, config)

    // ── Register hooks ────────────────────────────
    // TODO: Implement hooks (Phase 5)
    // await registerHooks(ctx, config)

    console.log("[memory] Plugin initialized successfully")

    // ── Cleanup ───────────────────────────────────
    return () => {
      console.log("[memory] Plugin unloaded")
    }
  },
})
