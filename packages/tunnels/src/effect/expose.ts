import { spawn } from "node:child_process"
import { Effect, Scope } from "effect"
import { BinaryInstallError, TunnelProcessError } from "./errors.js"
import { CloudflaredBinary } from "./services/CloudflaredBinary.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_TIMEOUT_MS = 45_000
const TRYCLOUDFLARE_URL_PATTERN = /(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/
const REGISTERED_CONNECTION_PATTERN = /Registered tunnel connection/i

export interface ExposeOptions {
  /** Hostname or IP address of the local service to expose. Defaults to 127.0.0.1. */
  readonly host?: string
  /** Maximum time to wait for cloudflared readiness before rejecting. Defaults to 45 seconds. */
  readonly timeoutMs?: number
  /** Wait for cloudflared to report an edge connection in addition to the URL. Defaults to true. */
  readonly waitForRegisteredConnection?: boolean
  /** Optional destination for raw cloudflared stdout and stderr chunks. */
  readonly logTo?: NodeJS.WritableStream
}

/**
 * Quick-exposes a local port via an anonymous Cloudflare tunnel.
 *
 * @param port Local port to expose through trycloudflare.
 * @returns An Effect that succeeds with the generated URL and closes the tunnel when the scope closes.
 */
export const expose = (
  port: number,
  options: ExposeOptions = {},
): Effect.Effect<
  { readonly url: string },
  TunnelProcessError | BinaryInstallError,
  Scope.Scope | CloudflaredBinary
> =>
  Effect.gen(function* () {
    const binary = yield* CloudflaredBinary
    const binaryPath = yield* binary.ensureInstalled()
    const host = options.host ?? DEFAULT_HOST
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const waitForRegisteredConnection = options.waitForRegisteredConnection ?? true

    const proc = spawn(binaryPath, ["tunnel", "--url", `http://${host}:${port}`, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Auto-kill on scope close
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM")
      }),
    )

    // Wait for cloudflared to publish a URL and, by default, register an edge connection.
    const url: string = yield* Effect.callback<string, TunnelProcessError>((resume) => {
      let seenUrl: string | undefined
      let seenRegisteredConnection = !waitForRegisteredConnection
      let settled = false
      const cleanups: Array<() => void> = []

      const failMessage = () => {
        if (!seenUrl) return "Tunnel closed before URL was received"
        return "Tunnel closed before a registered connection was received"
      }

      const cleanup = () => {
        clearTimeout(timeout)
        for (const fn of cleanups.splice(0)) fn()
      }

      const finish = (effect: Effect.Effect<string, TunnelProcessError>) => {
        if (settled) return
        settled = true
        cleanup()
        resume(effect)
      }

      const maybeReady = () => {
        if (seenUrl && seenRegisteredConnection) finish(Effect.succeed(seenUrl))
      }

      const onLine = (line: string) => {
        const urlMatch = line.match(TRYCLOUDFLARE_URL_PATTERN)
        if (urlMatch) seenUrl = urlMatch[1]
        if (REGISTERED_CONNECTION_PATTERN.test(line)) seenRegisteredConnection = true
        maybeReady()
      }

      const attachOutput = (stream: NodeJS.ReadableStream) => {
        let buffered = ""
        const onData = (chunk: string | Buffer) => {
          options.logTo?.write(chunk)
          buffered += chunk.toString()
          const lines = buffered.split(/\r?\n/)
          buffered = lines.pop() ?? ""
          for (const line of lines) onLine(line)
          if (buffered) onLine(buffered)
        }

        stream.on("data", onData)
        cleanups.push(() => stream.off("data", onData))
      }

      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        const message = signal ? `${failMessage()} (signal ${signal})` : failMessage()
        const error: { message: string; exitCode?: number } = { message }
        if (typeof code === "number") error.exitCode = code
        finish(Effect.fail(new TunnelProcessError(error)))
      }

      const onError = (err: Error) => {
        finish(Effect.fail(new TunnelProcessError({ message: err.message })))
      }

      const timeout = setTimeout(() => {
        finish(
          Effect.fail(
            new TunnelProcessError({
              message: `Timed out after ${timeoutMs}ms waiting for quick tunnel readiness`,
            }),
          ),
        )
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM")
      }, timeoutMs)

      proc.on("close", onClose)
      proc.on("error", onError)
      cleanups.push(() => proc.off("close", onClose))
      cleanups.push(() => proc.off("error", onError))

      attachOutput(proc.stdout!)
      attachOutput(proc.stderr!)
    })

    return { url }
  })
