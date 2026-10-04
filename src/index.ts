/**
 * opencode-memory - Long-term memory plugin for OpenCode.
 *
 * Revised architecture (docs/08): evidence != derived memory,
 * single canonical store with kind/tier, scope as independent
 * dimension, context-hook ephemeral injection, stdio Python worker.
 *
 * This entry point wires configuration + storage namespaces only.
 * Retrieval / consolidation / tools / hooks land in later slices,
 * behind the benchmark harness.
 */

import { Plugin } from "@opencode/plugin"
import { resolveConfig } from "./config.js"
import { log } from "./utils/logger.js"

export default Plugin.define({
  id: "opencode-memory",

  async setup(ctx) {
    const config = resolveConfig(ctx.options as Record<string, unknown>)

    if (!config.enabled) {
      log("info", "Plugin disabled via configuration")
      return
    }

    log("info", "Initializing OpenCode Memory Plugin (schema v1)")
    log("info", `Storage backend (provisional): ${config.storageBackend}`)
    log("info", `Embedding model (provisional): ${config.embeddingModel}`)
    log("info", `Laya checkpoint: ${config.layaCheckpoint}`)
    log(
      "info",
      `Python transport: ${config.pythonTransport}` +
        (config.pythonTransport === "tcp"
          ? ` (localhost:${config.pythonPort})`
          : ""),
    )

    await ctx.storage.set("config", { ...config })
    await ctx.storage.set("initialized", true)
    await ctx.storage.set("stats", {
      totalMemories: 0,
      lastStore: null,
      lastRecall: null,
    })

    // Slices 2+: tools (remember/search/forget/explain), context-hook
    // ephemeral recall, handoff protocol. See docs/08 §22.

    log("info", "Plugin initialized successfully")

    return () => {
      log("info", "Plugin unloaded")
    }
  },
})
