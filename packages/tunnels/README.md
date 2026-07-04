# tunnels

TypeScript SDK for Cloudflare Tunnels — full lifecycle management in one package.

Handles API calls, binary management, process lifecycle, streaming logs, and cleanup. No separate `cloudflared` install required.

## Install

```bash
npm install tunnels
```

### From a Git branch or fork

```json
{
  "dependencies": {
    "tunnels": "github:irvinebroque/tunnels-sdk#feat/tunnels-vite-plugin"
  }
}
```

The repository root exposes this package for git installs and builds `packages/tunnels` during the install prepare step.

## What This PR Adds

This package now owns the generic quick-tunnel lifecycle for local development tools and test runners.

- Start an anonymous Cloudflare quick tunnel from TypeScript with `expose(port, options)`.
- Read the generated public `https://*.trycloudflare.com` URL programmatically.
- Choose the local host used for the origin URL, defaulting to `127.0.0.1`.
- Wait for both URL discovery and registered edge connection readiness before returning.
- Fail startup with a timeout and cleanly terminate `cloudflared` if readiness never happens.
- Forward raw `cloudflared` stdout and stderr to any writable stream.
- Use `tunnels/vite` to bind a quick tunnel to Vite dev-server startup and shutdown.
- Publish the generated URL to one or more environment variables without hardcoding Browser Run or Vitest concepts into the SDK.
- Install the fork or branch directly from git while still importing `tunnels` and `tunnels/vite` from another project.

This package intentionally stays generic. Browser Run, Vitest Browser Mode, Playwright, or any other remote browser tool can consume the URL, but this SDK does not own Browser Run credentials, provider behavior, browser-specific rewriting, or a hardcoded `VITEST_BROWSER_PUBLIC_ORIGIN` concept.

## Public Entrypoints

| Import | Purpose |
|--------|---------|
| `tunnels` | High-level SDK exports, including `expose`, `TunnelClient`, `ExposeOptions`, and `ExposedTunnel`. |
| `tunnels/vite` | Vite-compatible quick-tunnel plugin, including `viteTunnel` and Vite plugin option/context types. |
| `tunnels/effect` | Effect-native SDK exports for consumers already using Effect. |
| `tunnels/bin` | Managed `cloudflared` binary resolver and installer. |

The git-dependency facade at the repository root forwards these entrypoints to `packages/tunnels/dist` after the install `prepare` step builds the package.

## Quick start

### One-liner expose

```ts
import { expose } from "tunnels"

// Expose a local port — binary auto-downloaded on first use
await using tunnel = await expose(3000)
console.log(tunnel.url) // https://abc123.trycloudflare.com

// Or manage cleanup manually
const tunnel = await expose(3000)
await tunnel.close()
```

### Vite dev-server tunnel

```ts
import { defineConfig } from "vite"
import { viteTunnel } from "tunnels/vite"

export default defineConfig({
  plugins: [
    viteTunnel({
      port: 3000,
      env: "PUBLIC_DEV_SERVER_URL",
      onReady: ({ url }) => {
        console.log(`Tunnel ready: ${url}`)
      },
    }),
  ],
})
```

`viteTunnel()` starts with the Vite dev server by default, publishes the generated URL to `process.env.PUBLIC_DEV_SERVER_URL`, calls `onReady`, and closes the tunnel when Vite shuts down.

### Vitest Browser Mode

`viteTunnel` is generic. Vitest Browser Mode can consume it by publishing the generated URL to the env var your browser provider already reads.

```ts
import { defineConfig } from "vitest/config"
import { viteTunnel } from "tunnels/vite"

export default defineConfig({
  plugins: [
    viteTunnel({
      port: 63315,
      env: "VITEST_BROWSER_PUBLIC_ORIGIN",
    }),
  ],
})
```

This is only an example consumer. `env` can be any variable name or list of names that your app, runner, or provider reads.

> Security: quick tunnels expose your local dev server on a public `trycloudflare.com` URL. Only tunnel services you are comfortable making reachable from the Internet.

Cloudflare's official Vite plugin also supports local dev tunnels. Use this SDK plugin when you need programmatic access to the generated URL, callback hooks, or env publishing from `tunnels`.

### Full API access

```ts
import { TunnelClient } from "tunnels"

const client = new TunnelClient({
  accountId: process.env.CF_ACCOUNT_ID!,
  apiToken: process.env.CF_API_TOKEN!,
})

// Create tunnel + configure ingress + create DNS — one call
// DNS is inferred from ingress hostnames by default.
const tunnel = await client.tunnels.create("my-app", {
  ingress: [
    { hostname: "app.example.com", service: "http://localhost:3000" },
    { hostname: "api.example.com", service: "http://localhost:8080" },
  ],
})

// Run it
await using proc = await tunnel.run()
await proc.waitUntilHealthy()
```

---

## API

### `expose(port, options?)`

Creates an anonymous quick tunnel. No auth required.

Public API:

```ts
import { expose } from "tunnels"
import type { ExposedTunnel, ExposeOptions } from "tunnels"

export interface ExposeOptions {
  host?: string
  timeoutMs?: number
  waitForRegisteredConnection?: boolean
  logTo?: NodeJS.WritableStream
}

export interface ExposedTunnel {
  readonly url: string
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export function expose(port: number, options?: ExposeOptions): Promise<ExposedTunnel>
```

Basic usage:

```ts
const tunnel = await expose(3000)
tunnel.url   // https://abc123.trycloudflare.com
await tunnel.close()
```

Recommended explicit usage:

```ts
const tunnel = await expose(63315, {
  host: "127.0.0.1",
  timeoutMs: 45_000,
  waitForRegisteredConnection: true,
  logTo: process.stderr,
})
```

With explicit resource management:

```ts
await using tunnel = await expose(3000)
console.log(tunnel.url)
```

With log forwarding:

```ts
const tunnel = await expose(3000, {
  logTo: process.stderr,
})
```

Option reference:

- `host`: local host/IP to expose. Defaults to `127.0.0.1`.
- `timeoutMs`: startup readiness timeout. Defaults to `45_000`.
- `waitForRegisteredConnection`: wait for a registered edge connection before resolving. Defaults to `true`.
- `logTo`: writable stream that receives raw `cloudflared` stdout/stderr chunks.

Runtime behavior:

- Spawns `cloudflared tunnel --url http://${host}:${port} --no-autoupdate`.
- Resolves only after a `https://*.trycloudflare.com` URL is seen and, by default, `cloudflared` reports `Registered tunnel connection`.
- Rejects with a `TunnelProcessError` when readiness does not happen before `timeoutMs`.
- Kills the `cloudflared` child process when startup fails, `close()` is called, `[Symbol.asyncDispose]()` runs, or the owning Effect scope closes.
- `close()` is idempotent, so callers can safely close from multiple shutdown hooks.
- The generated URL is returned only on the handle. The core SDK does not mutate `process.env`; the Vite plugin owns optional env publishing.

### `viteTunnel(options?)`

Starts an anonymous quick tunnel for a Vite dev server and closes it with the server lifecycle.

Public API:

```ts
import { viteTunnel } from "tunnels/vite"
import type { ExposeOptions, ExposedTunnel } from "tunnels"
import type {
  ViteTunnelOptions,
  ViteTunnelPortContext,
  ViteTunnelReadyContext,
  ViteTunnelCloseContext,
  ViteTunnelDevServer,
  ViteTunnelPlugin,
} from "tunnels/vite"

export interface ViteTunnelOptions extends ExposeOptions {
  enabled?: boolean
  autoStart?: boolean
  port?: number | ((context: ViteTunnelPortContext) => number | Promise<number>)
  env?: string | readonly string[] | false
  existingOrigin?: string
  onReady?: (context: ViteTunnelReadyContext) => void | Promise<void>
  onClose?: (context: ViteTunnelCloseContext) => void | Promise<void>
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

export function viteTunnel(options?: ViteTunnelOptions): ViteTunnelPlugin
```

Basic usage:

```ts
import { viteTunnel } from "tunnels/vite"

viteTunnel({
  port: ({ server }) => server.config.server.port ?? 63315,
  host: "127.0.0.1",
  env: ["PUBLIC_DEV_SERVER_URL", "VITEST_BROWSER_PUBLIC_ORIGIN"],
  existingOrigin: process.env.VITEST_BROWSER_PUBLIC_ORIGIN,
  onReady: ({ url }) => {
    console.log(`Tunnel ready: ${url}`)
  },
})
```

Use an existing origin instead of starting a new tunnel:

```ts
viteTunnel({
  existingOrigin: process.env.PUBLIC_DEV_SERVER_URL,
  env: "PUBLIC_DEV_SERVER_URL",
  onReady: ({ url, tunnel }) => {
    console.log(`Using ${url}`)
    console.log(tunnel) // undefined when existingOrigin is used
  },
})
```

Resolve the port from the Vite server:

```ts
viteTunnel({
  port: ({ server }) => server.config.server.port ?? 63315,
})
```

Publish to multiple consumers:

```ts
viteTunnel({
  port: 63315,
  env: ["PUBLIC_DEV_SERVER_URL", "VITEST_BROWSER_PUBLIC_ORIGIN"],
})
```

Option reference:

- `enabled`: set `false` to no-op.
- `autoStart`: set `false` to prevent starting a tunnel. Defaults to `true`.
- `port`: local port or callback. Defaults to `server.config.server.port`.
- `env`: env var name, list of names, or `false` to disable env publishing.
- `existingOrigin`: publish and report an already-known origin instead of starting a tunnel.
- `onReady`: callback after a URL is available.
- `onClose`: callback after a started tunnel is closed.

Lifecycle behavior:

- Runs only for Vite serve mode through a structural plugin shape; `vite` is not a runtime dependency.
- In `configureServer`, no-ops immediately when `enabled === false`.
- If `existingOrigin` is provided, publishes that URL to `env`, calls `onReady({ url, server })`, and does not call `expose()`.
- If `autoStart === false`, does not start a tunnel.
- Resolves the port from `options.port`, a port callback, or `server.config.server.port`.
- Starts `expose(port, exposeOptions)` with all shared `ExposeOptions`, including `host`, `timeoutMs`, `waitForRegisteredConnection`, and `logTo`.
- Publishes `tunnel.url` to each configured env var before calling `onReady`.
- Closes the tunnel when Vite's HTTP server emits `close` and again from `closeBundle`; duplicate close attempts are safe.

When to use this plugin:

- Use it when another tool needs the generated public URL as an env var or callback during Vite startup.
- Use it when your test runner or remote browser needs to hit a local dev server through a public origin.
- Prefer Cloudflare's official Vite plugin if you only need its local dev tunnel behavior and do not need this SDK's programmatic URL/callback/env surface.

### `TunnelClient`

Entry point for the full API. Exposes `tunnels` (create, list, get, delete) and `vnets` (create, list, delete).

```ts
const client = new TunnelClient({
  accountId: "...",
  apiToken: "...",
  binaryPath: "/custom/cloudflared",  // optional — skips auto-download
  baseUrl: "https://api.cloudflare.com/client/v4", // optional
})
```

#### `client.tunnels.create(name, options?)`

```ts
const tunnel = await client.tunnels.create("my-app", {
  ingress: [
    { hostname: "app.example.com", service: "http://localhost:3000" },
  ],
  // Optional DNS policy. Omit for { auto: true, cleanup: true, overwrite: false }.
  dns: { overwrite: false },
  routes: [
    { network: "10.0.0.0/8", vnet: "production" },
  ],
})
```

Creates the tunnel, pushes ingress config, creates DNS CNAMEs for ingress hostnames by default, and adds routes — all in sequence. Returns a `Tunnel`.

DNS policy defaults to `{ auto: true, cleanup: true, overwrite: false }`. Use `dns: false` or `dns: { auto: false }` to disable automatic DNS. Conflicting DNS records fail unless you pass `dns: { overwrite: true }`. Deleting a tunnel cleans up only SDK-owned DNS records marked for cleanup.

#### `client.tunnels.for(name, options?)`

```ts
const tunnel = await client.tunnels.for("my-app", {
  ingress: [
    { hostname: "app.example.com", service: "http://localhost:3000" },
  ],
})
```

Looks for an existing tunnel with the exact name and returns it. If none exists, creates one with the same options as `create`. Options are only applied when a tunnel is created.

#### `client.tunnels.list(options?)`

```ts
const tunnels = await client.tunnels.list()
const active = await client.tunnels.list({ status: "healthy" })
const byName = await client.tunnels.list({ name: "my-app" })

// Paginated
for await (const tunnel of client.tunnels.listAll()) {
  console.log(tunnel.name)
}
```

#### `client.tunnels.get(nameOrId)`

```ts
const tunnel = await client.tunnels.get("my-app")           // by name
const tunnel = await client.tunnels.get("c1744f8b-...")      // by UUID
```

#### `client.tunnels.delete(nameOrId, options?)`

```ts
await client.tunnels.delete("my-app", {
  force: true,        // delete even with active connections
  cleanupDns: false,  // optional: skip SDK-owned DNS cleanup (defaults to true)
})
```

### `Tunnel`

Represents a tunnel. Provides properties (snapshot from last API fetch), sub-managers for ingress/DNS/routes, and methods to run and monitor.

```ts
tunnel.id          // "c1744f8b-..."
tunnel.name        // "my-app"
tunnel.status      // "healthy" | "inactive" | "degraded" | "down"
tunnel.createdAt   // Date
tunnel.connections // TunnelConnection[]

await tunnel.refresh()            // re-fetch from API
const token = await tunnel.getToken()  // cached after first call
```

#### `tunnel.run(options?)`

```ts
const proc = await tunnel.run({ logLevel: "info" })
proc.status       // "healthy" | "inactive" | "degraded" | "down"
proc.connectors   // ConnectorInfo[]

await proc.waitUntilHealthy()  // resolves when 4 connectors up
await proc.close()             // graceful SIGTERM → SIGKILL fallback
```

Supports `AbortSignal` for cancellation:

```ts
const controller = new AbortController()
const proc = await tunnel.run({ signal: controller.signal })
controller.abort() // stops the tunnel
```

#### `tunnel.ingress`

```ts
const rules = await tunnel.ingress.list()
await tunnel.ingress.add({
  hostname: "new.example.com",
  service: "http://localhost:9090",
  originRequest: { connectTimeout: "60s", noTLSVerify: true },
})
await tunnel.ingress.remove("old.example.com")
await tunnel.ingress.set([
  { hostname: "app.example.com", service: "http://localhost:3000" },
  // catch-all auto-appended if missing
])
```

#### `tunnel.dns`

```ts
await tunnel.dns.ensure("app.example.com")  // idempotent CNAME
await tunnel.dns.ensure("app.example.com", { proxied: true, ttl: 300 })
await tunnel.dns.remove("old.example.com")
const records = await tunnel.dns.list()
// [{ hostname, type, content }]
```

#### `tunnel.routes`

```ts
await tunnel.routes.add("10.0.0.0/8", { vnet: "production", comment: "prod" })
const routes = await tunnel.routes.list()
const result = await tunnel.routes.check("10.1.2.3")
// { tunnel: "my-app", route: "10.0.0.0/8", vnet: "production" } | null
await tunnel.routes.remove("10.0.0.0/8")
```

#### `client.vnets`

```ts
await client.vnets.create("production", { default: true, comment: "main" })
const vnets = await client.vnets.list()
await client.vnets.delete("staging")
```

### Streaming logs

Requires a running process. Returns an async iterable.

```ts
const proc = await tunnel.run()

for await (const entry of tunnel.logs()) {
  // { timestamp: Date, level, event, message, connectorId?, ...extra }
}

for await (const entry of tunnel.logs({ level: "error", since: "5m" })) {
  alertSlack(entry)
}

const errors = await tunnel.logs({ level: "error", since: "1h" }).toArray()
```

### Typed events

```ts
const proc = await tunnel.run()

proc.on("connected", (conn) => {
  // ConnectorInfo: { id, colo, ip, location }
})
proc.on("disconnected", (conn) => { ... })
proc.on("reconnecting", (attempt) => {
  // ReconnectAttempt: { number, delay, connector }
})
proc.on("error", (err) => {
  // TunnelError: { code, message, retryable, connector? }
})
proc.on("metrics", (m) => {
  // TunnelMetrics: { rps, p50Ms, p99Ms, activeConns, bytesIn, bytesOut }
})
proc.on("status", (s) => {
  // TunnelStatus: "healthy" | "degraded" | "inactive" | "down"
})
proc.on("exit", (code) => { ... })
```

### Config validation

Zod-powered schema validation for tunnel config files.

```ts
import { TunnelConfig } from "tunnels"

const config = TunnelConfig.parse({
  ingress: [
    { hostname: "app.example.com", service: "http://localhost:3000" },
  ],
})
// catch-all auto-appended when autoFallback is true (default)

const result = TunnelConfig.safeParse({ ingress: [] })
if (!result.success) console.error(result.error.format())

const config = await TunnelConfig.fromFile("./tunnels.yaml")
const config = TunnelConfig.fromYaml("ingress:\n  - ...")
```

Validates: ingress ordering, catch-all presence, hostname format, service URL scheme, no duplicate hostnames, no unknown keys, origin request fields.

### Binary management

The `cloudflared` binary is auto-downloaded, platform-matched, and version-locked on first use. Stored in `node_modules/.cache/tunnels/bin/`.

```ts
import { cloudflared } from "tunnels/bin"

cloudflared.path       // "/path/to/cloudflared"
cloudflared.version    // "2025.2.0"

await cloudflared.isInstalled()
await cloudflared.install()
await cloudflared.install({ version: "2025.1.0" })
await cloudflared.update()   // latest from GitHub releases
await cloudflared.remove()
```

Quick tunnels use this managed cached binary automatically. Use `tunnels/bin` if you need to preinstall, update, or remove the cached `cloudflared` binary outside the `expose()` lifecycle.

---

## Architecture

### Module structure

```
src/
├── api/
│   ├── client.ts          ApiClient — HTTP client for CF API
│   ├── interfaces.ts      IApiClient interface
│   └── types.ts           Cloudflare API response types
├── bin/
│   ├── cloudflared.ts     Binary download/install/manage
│   └── index.ts           BinaryResolver interface + re-export
├── managers/
│   ├── dns/               DnsManager + types + test
│   ├── ingress/           IngressManager + types + test
│   ├── routes/            RouteManager + types + test
│   └── vnets/             VNetManager + types + test
├── client.ts              TunnelClient — main entry point
├── tunnel.ts              Tunnel — single tunnel instance
├── tunnel-operations.ts   TunnelOperations — create/list/get/delete
├── process.ts             TunnelProcess — cloudflared child process
├── expose.ts              expose() — quick anonymous tunnels
├── logs.ts                LogStream — structured log parsing
├── config/schema.ts       TunnelConfig — Zod validation
├── defaults.ts            Composition root — production wiring
├── errors.ts              Error classes
└── index.ts               Public API barrel
```

Each manager directory is self-contained with its own types, implementation, test, and barrel export.

### Dependency injection

Every class accepts its dependencies through constructor injection. No module-level singletons, no `vi.mock` required for testing.

**`IApiClient`** — the core seam. All managers and operations depend on this interface, not the concrete `ApiClient`. Tests inject a mock that satisfies the interface structurally.

```ts
// Production — TunnelClient wires everything
const client = new TunnelClient({ accountId: "...", apiToken: "..." })

// Testing — inject a mock API
import { createMockApi } from "./test-utils.js"
const api = createMockApi()
api.get.mockResolvedValueOnce([...])
const ops = new TunnelOperations({ api })
```

**`TunnelClient`** accepts optional `TunnelClientDeps` to override the API client, process factory, and binary resolver:

```ts
const client = new TunnelClient(
  { accountId: "acct", apiToken: "token" },
  { api: myMockApi },  // bypasses real HTTP entirely
)
```

**`Tunnel`** accepts `TunnelDeps` — the API client, binary resolver, and process factory:

```ts
const tunnel = new Tunnel(cfTunnelData, {
  api: mockApi,
  processFactory: { start: vi.fn() },
  binaryResolver: { path: "/mock", isInstalled: vi.fn(), install: vi.fn() },
})
```

**`TunnelOperations`** accepts `TunnelOperationsDeps`:

```ts
const ops = new TunnelOperations({
  api: mockApi,
  binaryPath: "/custom/cloudflared",
})
```

**Key interfaces:**

| Interface | Defined in | Purpose |
|-----------|-----------|---------|
| `IApiClient` | `api/interfaces.ts` | HTTP client abstraction |
| `BinaryResolver` | `bin/index.ts` | Binary install/detect |
| `ProcessFactory` | `process.ts` | Creates `TunnelProcess` instances |
| `ProcessSpawner` | `process.ts` | Wraps `child_process.spawn` |

The concrete `cloudflared` module is loaded lazily by `CloudflaredBinary.layer`. Consumers who provide their own `CloudflaredBinary` service never load it.

### `defaults.ts` — composition root

Wires production defaults for use outside `TunnelClient`:

```ts
import { createDefaultTunnelDeps } from "tunnels"

const deps = createDefaultTunnelDeps(apiClient)
const tunnel = new Tunnel(data, deps)
```

---

## Testing

118 tests across 15 files. Zero `vi.mock`, zero `as any` on API mocks.

```bash
pnpm test         # run once
pnpm test:watch   # watch mode
```

All API testing uses `createMockApi()` which returns a `MockApiClient` — a plain object that satisfies `IApiClient` structurally with vitest mocks on every method. No casting, no module mocking.

```ts
import { createMockApi } from "./test-utils.js"

const api = createMockApi()
api.get.mockResolvedValueOnce([{ id: "t-1", name: "my-tunnel", ... }])
api.post.mockResolvedValueOnce({ id: "t-1", ... })

// accountPath/zonePath work out of the box
api.accountPath("/cfd_tunnel") // "/accounts/acct/cfd_tunnel"
api.zonePath("zone-1", "/dns_records") // "/zones/zone-1/dns_records"
```
