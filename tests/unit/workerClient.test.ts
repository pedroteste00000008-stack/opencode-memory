import { afterEach, describe, expect, it } from "vitest"
import {
  PythonWorkerClient,
  WorkerNotLoadedError,
  WorkerUnavailableError,
} from "../../src/worker/client.js"

const workerPath = new URL(
  "../../python/worker.py",
  import.meta.url,
).pathname

const baseOpts = {
  workerPath,
  layaCheckpoint: "convaiinnovations/laya-multilingual",
  embeddingModel: "intfloat/multilingual-e5-small",
}

let client: PythonWorkerClient | null = null

afterEach(async () => {
  await client?.stop().catch(() => {})
  client = null
})

describe("PythonWorkerClient", () => {
  it("handshakes with protocol version and capabilities", async () => {
    client = new PythonWorkerClient(baseOpts)
    const hs = await client.start()
    expect(hs.protocol_version).toBe(1)
    expect(hs.capabilities).toContain("embed")
  })

  it("fails closed on ML methods without weights", async () => {
    client = new PythonWorkerClient(baseOpts)
    await client.start()
    await expect(client.call("embed", { texts: ["hi"] })).rejects.toBeInstanceOf(
      WorkerNotLoadedError,
    )
  })

  it("surfaces unknown methods as errors and stays usable", async () => {
    client = new PythonWorkerClient(baseOpts)
    await client.start()
    await expect(client.call("nope")).rejects.toThrow(/unknown method/)
    const health = (await client.call("health")) as { status: string }
    expect(health.status).toBe("ok")
  })

  it("restarts within budget after a crash", async () => {
    client = new PythonWorkerClient({ ...baseOpts, maxRestarts: 1 })
    await client.start()
    // Simulate a crash: kill the child directly.
    const proc = (client as unknown as { proc: { kill: (s: string) => void } }).proc
    proc.kill("SIGKILL")
    await new Promise((r) => setTimeout(r, 500))
    const health = (await client.call("health")) as { status: string }
    expect(health.status).toBe("ok")
    expect(client.restartCount).toBe(1)
  })

  it("exhausts the restart budget instead of looping forever", async () => {
    client = new PythonWorkerClient({
      ...baseOpts,
      workerPath: "/nonexistent/worker.py",
      maxRestarts: 0,
      startupTimeoutMs: 2000,
    })
    await expect(client.call("health")).rejects.toBeInstanceOf(
      WorkerUnavailableError,
    )
  }, 15000)
})
