/**
 * Managed stdio Python worker client (docs/08 §14).
 *
 * - Child process owned by the plugin: no fixed port, no exposed TCP,
 *   lifecycle bound to the plugin, explicit cleanup, bounded restarts.
 * - Versioned JSON-RPC 2.0 over stdin/stdout (one JSON object per line).
 * - Capture is bounded: every request has a timeout and never blocks
 *   the agent loop indefinitely (invariant #3).
 */

import { ChildProcess, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { log } from "../utils/logger.js"

export const WORKER_PROTOCOL_VERSION = 1

export interface WorkerHandshake {
  protocol_version: number
  schema_version: number
  python_version: string
  laya_checkpoint: string
  embedding_model: string
  reranker_model: string
  capabilities: string[]
}

export interface WorkerClientOptions {
  pythonPath?: string
  workerPath: string
  layaCheckpoint: string
  embeddingModel: string
  rerankerModel?: string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  maxRestarts?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class WorkerError extends Error {}
export class WorkerNotLoadedError extends WorkerError {}
export class WorkerUnavailableError extends WorkerError {}

export class PythonWorkerClient {
  private proc: ChildProcess | null = null
  private reader: ReturnType<typeof createInterface> | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private restarts = 0
  private stderrTail: string[] = []
  private starting: Promise<WorkerHandshake> | null = null

  constructor(private readonly opts: WorkerClientOptions) {}

  get restartCount(): number {
    return this.restarts
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  async start(): Promise<WorkerHandshake> {
    if (this.running) {
      throw new WorkerError("worker already running")
    }
    if (this.starting) return this.starting
    this.starting = this.spawnAndHandshake()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  async stop(): Promise<void> {
    this.failAllPending(new WorkerUnavailableError("worker stopped"))
    this.reader?.close()
    this.reader = null
    const proc = this.proc
    this.proc = null
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL")
          resolve()
        }, 2000)
        proc.once("exit", () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  /** Generic call; throws WorkerNotLoadedError when weights are absent. */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.running) {
      if (this.restarts >= (this.opts.maxRestarts ?? 3)) {
        throw new WorkerUnavailableError("worker restart budget exhausted")
      }
      this.restarts += 1
      await this.start()
    }
    const id = this.nextId++
    const timeoutMs = this.opts.requestTimeoutMs ?? 60_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WorkerError(`worker request '${method}' timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.proc!.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      )
    })
  }

  private async spawnAndHandshake(): Promise<WorkerHandshake> {
    const proc = spawn(
      this.opts.pythonPath ?? "python3",
      [this.opts.workerPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    this.proc = proc
    this.stderrTail = []
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString())
      if (this.stderrTail.length > 20) this.stderrTail.shift()
    })
    proc.once("exit", (code) => {
      log("warn", `Python worker exited (code=${code})`)
      this.proc = null
      this.reader?.close()
      this.reader = null
      this.failAllPending(
        new WorkerUnavailableError(`worker exited (code=${code})`),
      )
    })

    this.reader = createInterface({ input: proc.stdout! })
    this.reader.on("line", (line) => this.onLine(line))

    const timeoutMs = this.opts.startupTimeoutMs ?? 30_000
    const handshake = (await this.withTimeout(
      this.rawCall("handshake", {
        protocol_version: WORKER_PROTOCOL_VERSION,
        laya_checkpoint: this.opts.layaCheckpoint,
        embedding_model: this.opts.embeddingModel,
        reranker_model: this.opts.rerankerModel ?? "",
      }),
      timeoutMs,
      "worker handshake timed out",
    )) as WorkerHandshake

    if (handshake.protocol_version !== WORKER_PROTOCOL_VERSION) {
      await this.stop()
      throw new WorkerError(
        `worker protocol mismatch: got ${handshake.protocol_version}, want ${WORKER_PROTOCOL_VERSION}`,
      )
    }
    log("info", `Python worker ready (python ${handshake.python_version})`)
    return handshake
  }

  /** Direct call used during startup before `running` settles. */
  private rawCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const timeoutMs = this.opts.requestTimeoutMs ?? 60_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WorkerError(`worker request '${method}' timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.proc!.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      )
    })
  }

  private onLine(line: string): void {
    let msg: {
      id?: number
      result?: unknown
      error?: { code?: number; message?: string }
    }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      log("warn", `worker emitted non-JSON line: ${line.slice(0, 120)}`)
      return
    }
    if (msg.id === undefined || msg.id === null) return
    const pend = this.pending.get(msg.id)
    if (!pend) return
    this.pending.delete(msg.id)
    clearTimeout(pend.timer)
    if (msg.error !== undefined) {
      const code = msg.error.code ?? 0
      const message = msg.error.message ?? "unknown worker error"
      if (code === -32001) pend.reject(new WorkerNotLoadedError(message))
      else pend.reject(new WorkerError(`worker error ${code}: ${message}`))
    } else {
      pend.resolve(msg.result)
    }
  }

  private failAllPending(err: Error): void {
    for (const [, pend] of this.pending) {
      clearTimeout(pend.timer)
      pend.reject(err)
    }
    this.pending.clear()
  }

  private withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new WorkerError(message)), ms)
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e: unknown) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }

  /** Diagnostics for the `explain` surface. */
  diagnose(): { running: boolean; restarts: number; stderrTail: string[] } {
    return {
      running: this.running,
      restarts: this.restarts,
      stderrTail: [...this.stderrTail],
    }
  }
}
