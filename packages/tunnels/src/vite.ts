import { expose } from "./wrapper.js"
import type { ExposedTunnel, ExposeOptions } from "./wrapper.js"

type Awaitable<T> = T | Promise<T>

export interface ViteTunnelHttpServer {
  once(event: "close", listener: () => void): unknown
}

export interface ViteTunnelDevServer {
  readonly config: {
    readonly server: {
      readonly port?: number | null
    }
  }
  readonly httpServer?: ViteTunnelHttpServer | null
}

export interface ViteTunnelPortContext {
  readonly server: ViteTunnelDevServer
}

export interface ViteTunnelReadyContext {
  readonly url: string
  readonly tunnel?: ExposedTunnel
  readonly server: ViteTunnelDevServer
}

export interface ViteTunnelCloseContext {
  readonly url: string
  readonly tunnel: ExposedTunnel
  readonly server: ViteTunnelDevServer
}

export interface ViteTunnelOptions extends ExposeOptions {
  readonly enabled?: boolean
  readonly autoStart?: boolean
  readonly port?: number | ((context: ViteTunnelPortContext) => Awaitable<number>)
  readonly env?: string | readonly string[] | false
  readonly existingOrigin?: string
  readonly onReady?: (context: ViteTunnelReadyContext) => Awaitable<void>
  readonly onClose?: (context: ViteTunnelCloseContext) => Awaitable<void>
}

export interface ViteTunnelPlugin {
  readonly name: string
  readonly apply: "serve"
  configureServer(server: ViteTunnelDevServer): Awaitable<void>
  closeBundle(): Awaitable<void>
}

const publishEnv = (env: ViteTunnelOptions["env"], url: string) => {
  if (!env) return
  const names = Array.isArray(env) ? env : [env]
  for (const name of names) process.env[name] = url
}

const resolvePort = async (
  port: ViteTunnelOptions["port"],
  server: ViteTunnelDevServer,
): Promise<number> => {
  const resolved = typeof port === "function"
    ? await port({ server })
    : port ?? server.config.server.port

  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved <= 0) {
    throw new Error("viteTunnel requires a positive port option or server.config.server.port")
  }

  return resolved
}

export function viteTunnel(options: ViteTunnelOptions = {}): ViteTunnelPlugin {
  let server: ViteTunnelDevServer | undefined
  let tunnel: ExposedTunnel | undefined
  let url: string | undefined
  let closePromise: Promise<void> | undefined

  const closeTunnel = async () => {
    if (!server || !tunnel || !url) return

    const currentServer = server
    const currentTunnel = tunnel
    const currentUrl = url

    closePromise ??= (async () => {
      await currentTunnel.close()
      await options.onClose?.({ url: currentUrl, tunnel: currentTunnel, server: currentServer })
    })()

    await closePromise
  }

  return {
    name: "tunnels:vite",
    apply: "serve",
    async configureServer(viteServer) {
      server = viteServer

      if (options.enabled === false) return

      if (options.existingOrigin) {
        url = options.existingOrigin
        publishEnv(options.env, options.existingOrigin)
        await options.onReady?.({ url: options.existingOrigin, server: viteServer })
        return
      }

      if (options.autoStart === false) return

      const port = await resolvePort(options.port, viteServer)
      const {
        enabled: _enabled,
        autoStart: _autoStart,
        port: _port,
        env,
        existingOrigin: _existingOrigin,
        onReady,
        onClose: _onClose,
        ...exposeOptions
      } = options

      tunnel = await expose(port, exposeOptions)
      url = tunnel.url

      publishEnv(env, tunnel.url)
      await onReady?.({ url: tunnel.url, tunnel, server: viteServer })

      viteServer.httpServer?.once("close", () => {
        void closeTunnel()
      })
    },
    async closeBundle() {
      await closeTunnel()
    },
  }
}
