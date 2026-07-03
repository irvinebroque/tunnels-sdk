import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import {
  AuthError,
  AuthTokenSet as EffectAuthTokenSet,
  CloudflareApiConfig,
  CloudflareAuth,
  TunnelOperations as TunnelOpsService,
  IngressManager as IngressService,
  DnsManager as DnsService,
  RouteManager as RouteService,
  VNetManager as VNetService,
  TunnelProcessService,
  CloudflaredBinary,
  LiveLayer,
  expose as exposeEffect,
} from "./effect/index.js";
import type {
  TunnelInfo,
  IngressRule,
  Route,
  DnsRecord,
  VNet,
  RouteCheckResult,
  CreateTunnelOptions,
  TunnelListOptions,
  DeleteOptions,
  CloudflareAuthService,
  ExposeOptions,
} from "./effect/index.js";

// ---------------------------------------------------------------------------
// Re-export types for non-Effect consumers
// ---------------------------------------------------------------------------

/**
 * Core tunnel SDK data types for async/await consumers.
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
} from "./effect/index.js";

/**
 * Runtime tunnel status and log types for async/await consumers.
 */
export type {
  TunnelStatus,
  ConnectorInfo,
  LogEntry,
} from "./effect/index.js";

export type { ExposeOptions } from "./effect/index.js";

// Re-export config validation
/**
 * Tunnel configuration parsing helpers.
 */
export {
  parseConfig,
  parseConfigFromYaml,
  parseConfigFromFile,
} from "./effect/config.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a high-level tunnel client.
 */
export interface AuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

export interface CloudflareAuthProvider {
  getAccessToken(options?: { minTTLMillis?: number; }): Promise<string>;
  refresh(): Promise<AuthTokenSet>;
  revoke?(): Promise<void>;
}

export class EffectAuthProvider implements CloudflareAuthProvider {
  constructor(private readonly auth: CloudflareAuthService) { }

  getAccessToken(options?: { minTTLMillis?: number; }): Promise<string> {
    return Effect.runPromise(this.auth.getAccessToken(options));
  }

  async refresh(): Promise<AuthTokenSet> {
    const tokens = await Effect.runPromise(this.auth.refresh());
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes ? [...tokens.scopes] : undefined,
    };
  }

  revoke(): Promise<void> {
    return Effect.runPromise(this.auth.revoke());
  }
}

export interface TunnelClientOptions {
  accountId: string;
  authProvider: CloudflareAuthProvider;
  baseUrl?: string;
}

const effectAuthFromProvider = (authProvider: CloudflareAuthProvider): CloudflareAuthService =>
  CloudflareAuth.of({
    getAccessToken: (options) =>
      Effect.tryPromise({
        try: () => authProvider.getAccessToken(options),
        catch: (cause) => new AuthError({ message: "Auth provider failed to get an access token.", cause }),
      }),
    refresh: () =>
      Effect.tryPromise({
        try: async () => new EffectAuthTokenSet(await authProvider.refresh()),
        catch: (cause) => new AuthError({ message: "Auth provider failed to refresh.", cause }),
      }),
    revoke: () =>
      authProvider.revoke
        ? Effect.tryPromise({
            try: () => authProvider.revoke!(),
            catch: (cause) => new AuthError({ message: "Auth provider failed to revoke.", cause }),
          })
        : Effect.void,
  });

// ---------------------------------------------------------------------------
// Runtime type — the context provided by LiveLayer
// ---------------------------------------------------------------------------

type ClientServices =
  | TunnelOpsService
  | IngressService
  | DnsService
  | RouteService
  | VNetService
  | CloudflaredBinary
  | TunnelProcessService;

// The LiveLayer may error with BinaryInstallError during layer setup
type ClientRuntime = ManagedRuntime.ManagedRuntime<any, any>;

// ---------------------------------------------------------------------------
// Sub-clients
// ---------------------------------------------------------------------------

class TunnelClientTunnels {
  constructor(private readonly runtime: ClientRuntime) { }

  /**
   * Creates a new named tunnel.
   *
   * @param name Tunnel name to create.
   * @param options Optional ingress, DNS, and route setup options.
   * @returns A Promise resolving to the created tunnel.
   */
  async create(name: string, options?: CreateTunnelOptions): Promise<TunnelInfo> {
    return this.runtime.runPromise(
      TunnelOpsService.use((s) => s.create(name, options)),
    );
  }

  /**
   * Gets an existing tunnel by exact name or creates it with the provided options.
   *
   * Options are only applied when a tunnel is created.
   *
   * @param name Exact tunnel name to find or create.
   * @param options Optional creation options used only when creating the tunnel.
   * @returns A Promise resolving to the existing or created tunnel.
   */
  async for(name: string, options?: CreateTunnelOptions): Promise<TunnelInfo> {
    return this.runtime.runPromise(
      TunnelOpsService.use((s) => s.for(name, options)),
    );
  }

  /**
   * Lists named tunnels.
   *
   * @param options Optional list filters.
   * @returns A Promise resolving to matching tunnels.
   */
  async list(options?: TunnelListOptions): Promise<TunnelInfo[]> {
    const result = await this.runtime.runPromise(
      TunnelOpsService.use((s) => s.list(options)),
    );
    return [...result];
  }

  /**
   * Gets a named tunnel by name or ID.
   *
   * @param nameOrId Tunnel name or UUID.
   * @returns A Promise resolving to the tunnel.
   */
  async get(nameOrId: string): Promise<TunnelInfo> {
    return this.runtime.runPromise(
      TunnelOpsService.use((s) => s.get(nameOrId)),
    );
  }

  /**
   * Deletes a named tunnel by name or ID.
   *
   * @param nameOrId Tunnel name or UUID.
   * @param options Optional deletion options.
   * @returns A Promise that resolves when deletion completes.
   */
  async delete(nameOrId: string, options?: DeleteOptions): Promise<void> {
    return this.runtime.runPromise(
      TunnelOpsService.use((s) => s.del(nameOrId, options)),
    );
  }

  /**
   * Gets the run token for a tunnel ID.
   *
   * @param tunnelId Tunnel UUID.
   * @returns A Promise resolving to the tunnel token.
   */
  async getToken(tunnelId: string): Promise<string> {
    return this.runtime.runPromise(
      TunnelOpsService.use((s) => s.getToken(tunnelId)),
    );
  }

  /**
   * Iterates all named tunnels across paginated API responses.
   *
   * @returns An async generator of tunnel metadata.
   */
  async *listAll(): AsyncGenerator<TunnelInfo> {
    const items = await this.runtime.runPromise(
      TunnelOpsService.use((s) =>
        s.listAll().pipe(Stream.runCollect),
      ),
    );
    for (const item of items) {
      yield item;
    }
  }
}

class TunnelClientIngress {
  constructor(private readonly runtime: ClientRuntime) { }

  /**
   * Lists ingress rules for a tunnel.
   *
   * @param tunnelId Tunnel UUID.
   * @returns A Promise resolving to ingress rules.
   */
  async list(tunnelId: string): Promise<IngressRule[]> {
    const result = await this.runtime.runPromise(
      IngressService.use((s) => s.list(tunnelId)),
    );
    return [...result];
  }

  /**
   * Adds an ingress rule to a tunnel.
   *
   * @param tunnelId Tunnel UUID.
   * @param rule Ingress rule to add.
   * @returns A Promise that resolves when the rule is added.
   */
  async add(tunnelId: string, rule: IngressRule): Promise<void> {
    return this.runtime.runPromise(
      IngressService.use((s) => s.add(tunnelId, rule)),
    );
  }

  /**
   * Removes an ingress rule from a tunnel by hostname.
   *
   * @param tunnelId Tunnel UUID.
   * @param hostname Hostname whose ingress rule should be removed.
   * @returns A Promise that resolves when the rule is removed.
   */
  async remove(tunnelId: string, hostname: string): Promise<void> {
    return this.runtime.runPromise(
      IngressService.use((s) => s.remove(tunnelId, hostname)),
    );
  }

  /**
   * Replaces all ingress rules for a tunnel.
   *
   * @param tunnelId Tunnel UUID.
   * @param rules Complete ingress rule set to apply.
   * @returns A Promise that resolves when rules are updated.
   */
  async set(tunnelId: string, rules: ReadonlyArray<IngressRule>): Promise<void> {
    return this.runtime.runPromise(
      IngressService.use((s) => s.set(tunnelId, rules)),
    );
  }
}

class TunnelClientDns {
  constructor(private readonly runtime: ClientRuntime) { }

  /**
   * Creates or updates a DNS CNAME for a tunnel hostname.
   *
   * @param tunnelId Tunnel UUID.
   * @param hostname Hostname to point at the tunnel.
   * @param options Optional DNS record settings.
   * @returns A Promise that resolves when the DNS record is ensured.
   */
  async ensure(
    tunnelId: string,
    hostname: string,
    options?: { proxied?: boolean; ttl?: number; overwrite?: boolean; cleanup?: boolean; },
  ): Promise<void> {
    return this.runtime.runPromise(
      DnsService.use((s) => s.ensure(tunnelId, hostname, options)),
    );
  }

  /**
   * Removes a DNS CNAME by hostname.
   *
   * @param hostname Hostname to remove.
   * @returns A Promise that resolves when the DNS record is removed.
   */
  async remove(hostname: string): Promise<void> {
    return this.runtime.runPromise(
      DnsService.use((s) => s.remove(hostname)),
    );
  }

  /**
   * Lists DNS records that point to a tunnel.
   *
   * @param tunnelId Tunnel UUID.
   * @returns A Promise resolving to DNS records.
   */
  async list(tunnelId: string): Promise<DnsRecord[]> {
    const result = await this.runtime.runPromise(
      DnsService.use((s) => s.list(tunnelId)),
    );
    return [...result];
  }
}

class TunnelClientRoutes {
  constructor(private readonly runtime: ClientRuntime) { }

  /**
   * Adds a private-network route to a tunnel.
   *
   * @param tunnelId Tunnel UUID.
   * @param network CIDR network to route through the tunnel.
   * @param options Optional virtual network and comment settings.
   * @returns A Promise that resolves when the route is added.
   */
  async add(
    tunnelId: string,
    network: string,
    options?: { vnet?: string; comment?: string; },
  ): Promise<void> {
    return this.runtime.runPromise(
      RouteService.use((s) => s.add(tunnelId, network, options)),
    );
  }

  /**
   * Removes a private-network route from a tunnel.
   *
   * @param tunnelId Tunnel UUID.
   * @param network CIDR network to remove.
   * @returns A Promise that resolves when the route is removed.
   */
  async remove(tunnelId: string, network: string): Promise<void> {
    return this.runtime.runPromise(
      RouteService.use((s) => s.remove(tunnelId, network)),
    );
  }

  /**
   * Lists private-network routes for a tunnel.
   *
   * @param tunnelId Tunnel UUID.
   * @returns A Promise resolving to private-network routes.
   */
  async list(tunnelId: string): Promise<Route[]> {
    const result = await this.runtime.runPromise(
      RouteService.use((s) => s.list(tunnelId)),
    );
    return [...result];
  }

  /**
   * Checks which private-network route would receive an IP address.
   *
   * @param ip IP address to check.
   * @returns A Promise resolving to the matched route or null.
   */
  async check(ip: string): Promise<RouteCheckResult | null> {
    return this.runtime.runPromise(
      RouteService.use((s) => s.check(ip)),
    );
  }
}

class TunnelClientVNets {
  constructor(private readonly runtime: ClientRuntime) { }

  /**
   * Creates a virtual network.
   *
   * @param name Virtual network name.
   * @param options Optional default and comment settings.
   * @returns A Promise resolving to the created virtual network.
   */
  async create(
    name: string,
    options?: { default?: boolean; comment?: string; },
  ): Promise<VNet> {
    return this.runtime.runPromise(
      VNetService.use((s) => s.create(name, options)),
    );
  }

  /**
   * Deletes a virtual network by name.
   *
   * @param name Virtual network name.
   * @returns A Promise that resolves when the virtual network is deleted.
   */
  async delete(name: string): Promise<void> {
    return this.runtime.runPromise(
      VNetService.use((s) => s.del(name)),
    );
  }

  /**
   * Lists virtual networks.
   *
   * @returns A Promise resolving to virtual networks.
   */
  async list(): Promise<VNet[]> {
    const result = await this.runtime.runPromise(
      VNetService.use((s) => s.list()),
    );
    return [...result];
  }
}

// ---------------------------------------------------------------------------
// TunnelClient
// ---------------------------------------------------------------------------

/**
 * High-level async/await client for Cloudflare Tunnel lifecycle management.
 */
export class TunnelClient {
  /** @internal */
  readonly _runtime: ClientRuntime;

  readonly tunnels: TunnelClientTunnels;
  readonly ingress: TunnelClientIngress;
  readonly dns: TunnelClientDns;
  readonly routes: TunnelClientRoutes;
  readonly vnets: TunnelClientVNets;

  /**
   * Creates a client backed by the production SDK layer.
   *
   * @param options Cloudflare account and API credentials.
   */
  constructor(options: TunnelClientOptions) {
    const config = new CloudflareApiConfig({
      accountId: options.accountId,
      baseUrl: options.baseUrl,
    });
    this._runtime = ManagedRuntime.make(
      LiveLayer(config, effectAuthFromProvider(options.authProvider)),
    );
    this.tunnels = new TunnelClientTunnels(this._runtime);
    this.ingress = new TunnelClientIngress(this._runtime);
    this.dns = new TunnelClientDns(this._runtime);
    this.routes = new TunnelClientRoutes(this._runtime);
    this.vnets = new TunnelClientVNets(this._runtime);
  }

  /**
   * Creates a TunnelClient from any layer.
   *
   * @param layer Layer that provides the client service dependencies.
   * @returns A TunnelClient backed by the supplied layer.
   * @internal
   */
  static _fromLayer(layer: Layer.Layer<ClientServices, any, never>): TunnelClient {
    const client = Object.create(TunnelClient.prototype);
    client._runtime = ManagedRuntime.make(layer);
    client.tunnels = new TunnelClientTunnels(client._runtime);
    client.ingress = new TunnelClientIngress(client._runtime);
    client.dns = new TunnelClientDns(client._runtime);
    client.routes = new TunnelClientRoutes(client._runtime);
    client.vnets = new TunnelClientVNets(client._runtime);
    return client;
  }

  /**
   * Disposes the managed runtime owned by this client.
   *
   * @returns A Promise that resolves when resources are released.
   */
  async dispose(): Promise<void> {
    await this._runtime.dispose();
  }
}

// ---------------------------------------------------------------------------
// expose() wrapper
// ---------------------------------------------------------------------------

/**
 * Handle returned by quick tunnel exposure.
 */
export interface ExposedTunnel {
  readonly url: string;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

interface ExposeRuntimeOptions extends ExposeOptions {
  readonly _binaryLayer?: Layer.Layer<CloudflaredBinary>;
}

/**
 * Quick-exposes a local port via an anonymous Cloudflare tunnel.
 *
 * Call `.close()` or use `await using` on the returned handle to shut down the tunnel. Optionally
 * pass options to control local host, readiness timeout, readiness checks, and log forwarding.
 *
 * @param port Local port to expose through trycloudflare.
 * @param options Optional quick tunnel configuration.
 * @returns A Promise resolving to the exposed tunnel handle.
 */
export function expose(port: number, options?: ExposeOptions): Promise<ExposedTunnel>;
export async function expose(
  port: number,
  options?: ExposeRuntimeOptions,
): Promise<ExposedTunnel> {
  const binaryLayer = options?._binaryLayer ?? CloudflaredBinary.layer;
  const runtime = ManagedRuntime.make(binaryLayer);

  // Create a scope we control — keeps the tunnel process alive until close()
  const scope = Effect.runSync(Scope.make());

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async () => {
    cleanupPromise ??= (async () => {
      // Close scope first — triggers SIGTERM finalizer on the tunnel process
      await Effect.runPromise(Scope.close(scope, Exit.void));
      // Then dispose the runtime
      await runtime.dispose();
    })();
    await cleanupPromise;
  };

  let result: { readonly url: string };
  try {
    result = await runtime.runPromise(
      exposeEffect(port, options).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    url: result.url,
    close: cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}
