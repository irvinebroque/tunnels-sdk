import { describe, it, assert } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { EventEmitter } from "node:events"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { CloudflaredBinary } from "./effect/services/CloudflaredBinary.js"
import { viteTunnel } from "./vite.js"
import type { ViteTunnelDevServer, ViteTunnelOptions } from "./vite.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const fakeBinaryPath = resolve(__dirname, "test-fixtures/fake-cloudflared.sh")

const FakeBinaryLayer = Layer.succeed(
  CloudflaredBinary,
  CloudflaredBinary.of({
    path: Effect.succeed(fakeBinaryPath),
    ensureInstalled: () => Effect.succeed(fakeBinaryPath),
    install: () => Effect.succeed(void 0),
    isInstalled: () => Effect.succeed(true),
  }),
)

class FakeHttpServer extends EventEmitter {
  close() {
    this.emit("close")
  }
}

const makeServer = (port?: number): ViteTunnelDevServer & { readonly httpServer: FakeHttpServer } => ({
  config: { server: { port } },
  httpServer: new FakeHttpServer(),
})

const withEnv = async <A>(
  env: Record<string, string | undefined>,
  run: () => Promise<A>,
): Promise<A> => {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) previous.set(key, process.env[key])

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const withFakeBinary = (options: ViteTunnelOptions = {}) =>
  ({ ...options, _binaryLayer: FakeBinaryLayer }) as ViteTunnelOptions

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

describe("viteTunnel", () => {
  it("starts a tunnel and publishes the URL to env", async () => {
    await withEnv({ PUBLIC_DEV_SERVER_URL: undefined }, async () => {
      const plugin = viteTunnel(withFakeBinary({ port: 63315, env: "PUBLIC_DEV_SERVER_URL" }))

      try {
        await plugin.configureServer(makeServer())
        assert.include(process.env.PUBLIC_DEV_SERVER_URL, "trycloudflare.com")
      } finally {
        await plugin.closeBundle()
      }
    })
  }, 10_000)

  it("skips tunnel startup when existingOrigin is provided", async () => {
    await withEnv({ PUBLIC_DEV_SERVER_URL: undefined }, async () => {
      let readyUrl: string | undefined
      const plugin = viteTunnel({
        existingOrigin: "https://existing.example.com",
        env: "PUBLIC_DEV_SERVER_URL",
        onReady: ({ url, tunnel }) => {
          readyUrl = url
          assert.isUndefined(tunnel)
        },
      })

      await plugin.configureServer(makeServer(63315))
      await plugin.closeBundle()

      assert.strictEqual(process.env.PUBLIC_DEV_SERVER_URL, "https://existing.example.com")
      assert.strictEqual(readyUrl, "https://existing.example.com")
    })
  })

  it("resolves port from server config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tunnels-vite-"))
    const argsFile = join(dir, "args.txt")

    try {
      await withEnv({ FAKE_CLOUDFLARED_ARGS_FILE: argsFile }, async () => {
        const plugin = viteTunnel(withFakeBinary())

        try {
          await plugin.configureServer(makeServer(4511))
        } finally {
          await plugin.closeBundle()
        }
      })

      const args = await readFile(argsFile, "utf8")
      assert.include(args, "http://127.0.0.1:4511")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it("closes the tunnel when the server closes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tunnels-vite-"))
    const termFile = join(dir, "terminated.txt")

    try {
      await withEnv({ FAKE_CLOUDFLARED_TERM_FILE: termFile }, async () => {
        const server = makeServer()
        const plugin = viteTunnel(withFakeBinary({ port: 63315 }))

        await plugin.configureServer(server)
        server.httpServer.close()
        await waitForFile(termFile)
        await plugin.closeBundle()
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it("calls onReady with the URL and tunnel", async () => {
    const server = makeServer()
    let readyUrl: string | undefined
    let hasTunnel = false
    const plugin = viteTunnel(withFakeBinary({
      port: 63315,
      onReady: ({ url, tunnel, server: readyServer }) => {
        readyUrl = url
        hasTunnel = Boolean(tunnel)
        assert.strictEqual(readyServer, server)
      },
    }))

    try {
      await plugin.configureServer(server)
      assert.include(readyUrl, "trycloudflare.com")
      assert.isTrue(hasTunnel)
    } finally {
      await plugin.closeBundle()
    }
  }, 10_000)

  it("supports multiple env vars", async () => {
    await withEnv({ PUBLIC_DEV_SERVER_URL: undefined, VITEST_BROWSER_PUBLIC_ORIGIN: undefined }, async () => {
      const plugin = viteTunnel({
        existingOrigin: "https://existing.example.com",
        env: ["PUBLIC_DEV_SERVER_URL", "VITEST_BROWSER_PUBLIC_ORIGIN"],
      })

      await plugin.configureServer(makeServer(63315))

      assert.strictEqual(process.env.PUBLIC_DEV_SERVER_URL, "https://existing.example.com")
      assert.strictEqual(process.env.VITEST_BROWSER_PUBLIC_ORIGIN, "https://existing.example.com")
    })
  })

  it("no-ops when disabled", async () => {
    await withEnv({ PUBLIC_DEV_SERVER_URL: undefined }, async () => {
      let readyCalled = false
      const plugin = viteTunnel({
        enabled: false,
        existingOrigin: "https://existing.example.com",
        env: "PUBLIC_DEV_SERVER_URL",
        onReady: () => {
          readyCalled = true
        },
      })

      await plugin.configureServer(makeServer(63315))

      assert.isUndefined(process.env.PUBLIC_DEV_SERVER_URL)
      assert.isFalse(readyCalled)
    })
  })
})
