import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyPluginCallback,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

/** A limit for one route. Same shape as `config.rateLimit` in `@fastify/rate-limit`. */
export interface RouteRateLimit {
  max: number;
  timeWindow: string | number;
}

/**
 * Routes that get their own, usually stricter, limit instead of the global one, keyed
 * `METHOD /pattern` exactly as the route is declared (`POST /v1/messages/:id/send`).
 */
export type RouteRateLimits = Readonly<Record<string, RouteRateLimit>>;

export interface RateLimitedRoutesOptions<Settings extends FastifyPluginOptions> {
  /**
   * The default export of `@fastify/rate-limit`. It is handed in, not imported here, so this
   * package carries no dependency on the plugin; the services already depend on it. `Settings` is
   * read from the plugin alone, so `settings` is checked against the plugin's own options.
   */
  plugin: FastifyPluginCallback<Settings> | FastifyPluginAsync<Settings>;
  /**
   * Forwarded to the plugin untouched: at least `max` and `timeWindow` (the service's
   * `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW`).
   *
   * Counters live in each function instance's memory unless a store is given here. This is the
   * hook for a shared one (`store` takes a class implementing the plugin's store interface, `redis`
   * takes an ioredis client): set it here, in one place per service, and nothing else changes.
   */
  settings: NoInfer<Settings>;
  /** See {@link RouteRateLimits}. */
  routeLimits?: RouteRateLimits;
}

/** What `@fastify/rate-limit` decorates onto the instance that loads it. */
interface RateLimitDecorated {
  rateLimit(): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Registers `@fastify/rate-limit` and hands `declareRoutes` the scope to declare the routes it
 * should limit in.
 *
 * Only routes declared on `scope` are limited. Routes declared on `app` itself are not, which is
 * how a service keeps `/health`, `/metrics` and the scheduler-called `/internal/.../drain` routes
 * (bearer-secret authenticated, so never to be throttled) out of the limiter.
 *
 * Why a scope and not `void app.register(rateLimit)` followed by routes on `app`: the plugin
 * limits a route through an `onRoute` hook that only exists once the plugin has loaded, and
 * loading is asynchronous. Routes declared on `app` straight after `register()` are declared
 * first, so the hook never sees them and they are silently not limited, global limit included.
 * The function passed here runs inside a child plugin, which Fastify loads strictly after the
 * rate-limit plugin, so every route declared on `scope` is covered. `scope` shares `app`'s error
 * handler and hooks, so a 429 comes out in the service's standard error envelope.
 *
 * Also limited, on the global budget: requests that match no route (unknown paths, unsupported
 * methods). They would otherwise be a free way to probe the API.
 *
 * Call it after registering CORS. A 429 then carries the CORS headers a browser needs to read it, and
 * CORS preflights (answered by the CORS plugin's own route) do not spend the budget.
 *
 * Clients are told apart by `request.ip`, which with `trustProxy: true` is the first
 * `X-Forwarded-For` entry. Vercel overwrites that header with the real client address; behind a
 * proxy that only appends to it, a client could pick its own bucket, so use a hop count there.
 */
export function registerRateLimitedRoutes<Settings extends FastifyPluginOptions>(
  app: FastifyInstance,
  options: RateLimitedRoutesOptions<Settings>,
  declareRoutes: (scope: FastifyInstance) => void,
): void {
  const routeLimits = options.routeLimits ?? {};
  const unmatched = new Set(Object.keys(routeLimits));

  // Hooks run in the order they were added, and the plugin adds its own `onRoute` hook only when
  // it loads, which is after this line. Adding ours now means the plugin reads the per-route
  // limit we attach (it looks for `config.rateLimit` on the route).
  if (unmatched.size > 0) {
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        const key = `${method} ${route.url}`;
        const limit = routeLimits[key];
        if (limit === undefined) continue;
        unmatched.delete(key);
        // A limit written on the route itself wins over the table.
        if ((route.config as { rateLimit?: unknown } | undefined)?.rateLimit === undefined) {
          route.config = { ...route.config, rateLimit: { ...limit } } as typeof route.config;
        }
      }
    });

    // A limit that no longer matches a route (renamed, removed) would otherwise stop applying
    // without a sound, which is the failure this helper exists to prevent.
    app.addHook('onReady', async () => {
      if (unmatched.size > 0) {
        throw new Error(
          `Rate limit configured for routes that do not exist: ${[...unmatched].join(', ')}`,
        );
      }
    });
  }

  void app.register(options.plugin, options.settings);

  // The plugin limits a route from its `onRoute` hook, which a request that matches no route never
  // reaches, so those are limited here. The plugin has loaded by the time a request arrives, so
  // its `rateLimit` decorator exists; the handler is built once, on first use.
  let limitUnmatched: ReturnType<RateLimitDecorated['rateLimit']> | undefined;
  app.addHook('onRequest', async (request, reply) => {
    if (!request.is404) return;
    limitUnmatched ??= (app as unknown as RateLimitDecorated).rateLimit();
    await limitUnmatched(request, reply);
  });

  void app.register(async (scope) => {
    declareRoutes(scope);
  });
}
