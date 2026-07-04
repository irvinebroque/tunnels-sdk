// ---------------------------------------------------------------------------
// New Effect-backed async/await wrapper API
// ---------------------------------------------------------------------------

/**
 * High-level async/await tunnel client and quick expose helper.
 */
export { EffectAuthProvider, TunnelClient, expose } from "./wrapper.js"
export {
  AuthError,
  AuthTokenSet as EffectAuthTokenSet,
  CloudflareAuth,
  makeApiTokenAuth,
} from "./effect/index.js"
/**
 * High-level client options and quick expose handle types.
 */
export type {
  AuthTokenSet,
  CloudflareAuthProvider,
  TunnelClientOptions,
  ExposeOptions,
  ExposedTunnel,
} from "./wrapper.js"

// Re-export types from Effect SDK (no Effect knowledge required for consumers)
/**
 * Public tunnel SDK data types for async/await consumers.
 */
export type {
  TunnelInfo,
  IngressRule,
  Route,
  DnsRecord,
  VNet,
  RouteCheckResult,
  RunningTunnel,
  TunnelEvent,
  RunOptions,
  CreateTunnelOptions,
  TunnelListOptions,
  DeleteOptions,
  TunnelStatus,
  ConnectorInfo,
  LogEntry,
} from "./effect/index.js"

// Config validation
/**
 * Tunnel configuration parsing helpers.
 */
export { parseConfig, parseConfigFromYaml, parseConfigFromFile } from "./effect/config.js"
