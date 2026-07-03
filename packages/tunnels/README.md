# tunnels

TypeScript SDK for Cloudflare Tunnels — full lifecycle management in one package.

Handles API calls, binary management, process lifecycle, streaming logs, and cleanup. No separate `cloudflared` install required.

## Install

```bash
npm install tunnels
```

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

```ts
const tunnel = await expose(3000)
tunnel.url   // https://abc123.trycloudflare.com
await tunnel.close()

const tunnel = await expose(63315, {
  host: "127.0.0.1",
  timeoutMs: 45_000,
  waitForRegisteredConnection: true,
  logTo: process.stderr,
})
```

Options:

- `host`: local host/IP to expose. Defaults to `127.0.0.1`.
- `timeoutMs`: startup readiness timeout. Defaults to `45_000`.
- `waitForRegisteredConnection`: wait for a registered edge connection before resolving. Defaults to `true`.
- `logTo`: writable stream that receives raw `cloudflared` stdout/stderr chunks.

Returns an `ExposedTunnel` with `url`, `close()`, and `[Symbol.asyncDispose]()`.

### `viteTunnel(options?)`

Starts an anonymous quick tunnel for a Vite dev server and closes it with the server lifecycle.

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

Options extend `ExposeOptions` and add:

- `enabled`: set `false` to no-op.
- `autoStart`: set `false` to prevent starting a tunnel. Defaults to `true`.
- `port`: local port or callback. Defaults to `server.config.server.port`.
- `env`: env var name, list of names, or `false` to disable env publishing.
- `existingOrigin`: publish and report an already-known origin instead of starting a tunnel.
- `onReady`: callback after a URL is available.
- `onClose`: callback after a started tunnel is closed.

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
