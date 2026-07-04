import { describe, it, assert } from "@effect/vitest"
import { Effect, Layer, Scope, Exit } from "effect"
import { CloudflaredBinary } from "./services/CloudflaredBinary.js"
import { expose } from "./expose.js"
import { expose as exposeWrapper } from "../wrapper.js"
import type { ExposeOptions } from "../wrapper.js"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, dirname, join } from "node:path"
import { Writable } from "node:stream"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fakeBinaryPath = resolve(__dirname, "../test-fixtures/fake-cloudflared.sh")

/** Layer that provides our fake cloudflared binary */
const FakeBinaryLayer = Layer.succeed(
  CloudflaredBinary,
  CloudflaredBinary.of({
    path: Effect.succeed(fakeBinaryPath),
    ensureInstalled: () => Effect.succeed(fakeBinaryPath),
    install: () => Effect.succeed(void 0),
    isInstalled: () => Effect.succeed(true),
  }),
)

const fakeExposeOptions = (options: ExposeOptions = {}) =>
  ({ ...options, _binaryLayer: FakeBinaryLayer }) as ExposeOptions

const withFakeCloudflaredEnv = async <A>(
  env: Record<string, string>,
  run: () => Promise<A>,
): Promise<A> => {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) previous.set(key, process.env[key])

  Object.assign(process.env, env)
  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const waitForFile = async (path: string, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

describe("expose (Effect)", () => {
  it.effect("returns URL within a managed scope", () =>
    Effect.gen(function* () {
      const result = yield* expose(3000)
      assert.isTrue(result.url.includes("trycloudflare.com"))
      // Process is alive here — scope finalizer kills it when this block exits
    }).pipe(
      Effect.scoped,
      Effect.provide(FakeBinaryLayer),
    ),
  )
})

describe("expose() wrapper lifecycle", () => {
  it("returns URL and process stays alive until close()", async () => {
    const tunnel = await exposeWrapper(3000, fakeExposeOptions())

    // URL should be present — old bug: process was killed before this returned
    assert.isTrue(tunnel.url.includes("trycloudflare.com"))

    // close() should not throw and should kill the process
    await tunnel.close()
  }, 10_000)

  it("supports Symbol.asyncDispose", async () => {
    const tunnel = await exposeWrapper(3000, fakeExposeOptions())
    assert.isTrue(tunnel.url.includes("trycloudflare.com"))
    assert.strictEqual(typeof tunnel[Symbol.asyncDispose], "function")
    await tunnel[Symbol.asyncDispose]()
  }, 10_000)

  it("double close() is safe (idempotent)", async () => {
    const tunnel = await exposeWrapper(3000, fakeExposeOptions())
    await tunnel.close()
    // Second close should not throw
    await tunnel.close()
  }, 10_000)

  it("passes host, port, and no-autoupdate to cloudflared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tunnels-expose-"))
    const argsFile = join(dir, "args.txt")

    try {
      await withFakeCloudflaredEnv({ FAKE_CLOUDFLARED_ARGS_FILE: argsFile }, async () => {
        const tunnel = await exposeWrapper(4123, fakeExposeOptions({ host: "0.0.0.0" }))
        await tunnel.close()
      })

      const args = await readFile(argsFile, "utf8")
      assert.match(args, /--url\nhttp:\/\/0\.0\.0\.0:4123/)
      assert.match(args, /--no-autoupdate/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it("waits for registered tunnel connection by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tunnels-expose-"))
    const registeredFile = join(dir, "registered.txt")

    try {
      await withFakeCloudflaredEnv(
        {
          FAKE_CLOUDFLARED_MODE: "url-then-registered",
          FAKE_CLOUDFLARED_REGISTERED_FILE: registeredFile,
        },
        async () => {
          const tunnel = await exposeWrapper(3000, fakeExposeOptions())
          await tunnel.close()
        },
      )

      await access(registeredFile)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it("can return before registered tunnel connection when disabled", async () => {
    const tunnel = await withFakeCloudflaredEnv(
      { FAKE_CLOUDFLARED_MODE: "url-only" },
      () => exposeWrapper(3000, fakeExposeOptions({ waitForRegisteredConnection: false })),
    )

    assert.isTrue(tunnel.url.includes("trycloudflare.com"))
    await tunnel.close()
  }, 10_000)

  it("rejects on timeout and terminates cloudflared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tunnels-expose-"))
    const termFile = join(dir, "terminated.txt")

    try {
      await withFakeCloudflaredEnv(
        {
          FAKE_CLOUDFLARED_MODE: "never-ready",
          FAKE_CLOUDFLARED_TERM_FILE: termFile,
        },
        async () => {
          let error: unknown
          try {
            await exposeWrapper(3000, fakeExposeOptions({ timeoutMs: 50 }))
          } catch (caught) {
            error = caught
          }

          assert.isDefined(error)
          const message = error && typeof error === "object" && "message" in error
            ? String(error.message)
            : String(error)
          assert.match(message, /Timed out after 50ms/)
        },
      )

      await waitForFile(termFile)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it("forwards cloudflared output to logTo", async () => {
    const chunks: Buffer[] = []
    const logTo = new Writable({
      write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })

    const tunnel = await exposeWrapper(3000, fakeExposeOptions({ logTo }))
    await tunnel.close()

    assert.include(Buffer.concat(chunks).toString("utf8"), "trycloudflare.com")
  }, 10_000)
})
