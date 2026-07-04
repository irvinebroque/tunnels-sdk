// ─── Errors ───
/**
 * Tunnel SDK error types.
 */
export {
  TunnelSdkError,
  TunnelApiError,
  TunnelAuthError,
  TunnelNotFoundError,
  TunnelProcessError,
  BinaryInstallError,
  ConfigValidationError,
} from "./errors.js"

// ─── Schemas / Domain types ───
/**
 * Public tunnel SDK schemas and domain types.
 */
export {
  TunnelInfo,
  TunnelConnection,
  TunnelStatus,
  IngressRule,
  Route,
  RouteCheckResult,
  DnsRecord,
  VNet,
  ConnectorInfo,
  TunnelMetrics,
  LogEntry,
  LogLevel,
} from "./schemas.js"

// ─── Cloudflare wire types ───
/**
 * Cloudflare API wire schemas used by SDK services.
 */
export {
  CfTunnel,
  CfTunnelConnection,
  CfDnsRecord,
  CfZone,
  CfRoute,
  CfVirtualNetwork,
  CfIngressRule,
  CfTunnelConfig,
} from "./schemas.js"

// ─── Services ───
/**
 * Cloudflare API service and configuration schema.
 */
export { CloudflareApi, CloudflareApiConfig } from "./services/CloudflareApi.js"
export {
  AuthError,
  AuthTokenSet,
  CloudflareAuth,
  makeApiTokenAuth,
} from "./services/CloudflareAuth.js"
export type { CloudflareAuthService } from "./services/CloudflareAuth.js"
/**
 * High-level named tunnel operations service.
 */
export { TunnelOperations } from "./services/TunnelOperations.js"
/**
 * Options for high-level named tunnel operations.
 */
export type {
  CreateTunnelOptions,
  TunnelListOptions,
  DeleteOptions,
} from "./services/TunnelOperations.js"
/**
 * Ingress management service.
 */
export { IngressManager } from "./services/IngressManager.js"
/**
 * DNS management service.
 */
export { DnsManager } from "./services/DnsManager.js"
/**
 * Private-network route management service.
 */
export { RouteManager } from "./services/RouteManager.js"
/**
 * Virtual network management service.
 */
export { VNetManager } from "./services/VNetManager.js"
/**
 * cloudflared binary management service.
 */
export { CloudflaredBinary } from "./services/CloudflaredBinary.js"
/**
 * cloudflared process supervision service.
 */
export { TunnelProcessService } from "./services/TunnelProcess.js"
/**
 * Types emitted by tunnel process supervision.
 */
export type {
  RunningTunnel,
  TunnelEvent,
  RunOptions,
  ReconnectAttempt,
} from "./services/TunnelProcess.js"

// ─── Stderr parsing ───
/**
 * Utilities for parsing cloudflared stderr.
 */
export { processStderr, applyEvents, parseLine, toEvent } from "./services/parse-stderr.js"
/**
 * Streams returned by cloudflared stderr parsing.
 */
export type { StderrStreams } from "./services/parse-stderr.js"

// ─── Top-level Effects ───
/**
 * Anonymous quick tunnel Effect helper.
 */
export { expose } from "./expose.js"
export type { ExposeOptions } from "./expose.js"

// ─── Config ───
/**
 * Tunnel configuration parsing helpers.
 */
export {
  parseConfig,
  parseConfigFromYaml,
  parseConfigFromFile,
} from "./config.js"

// ─── Layers ───
/**
 * Production SDK layer.
 */
export { LiveLayer } from "./layers/Live.js"
/**
 * Stubbed SDK layer for tests.
 */
export { TestLayer } from "./layers/Test.js"
