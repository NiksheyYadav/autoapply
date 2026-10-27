import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The slice of a Fastify instance the serverless dispatcher touches. Declared
 * structurally so @atlas/utils does not have to depend on fastify just to
 * type the entrypoint glue — a `FastifyInstance` satisfies it as-is.
 */
export interface ServerlessApp {
  ready(): PromiseLike<unknown>;
  server: { emit(event: 'request', req: IncomingMessage, res: ServerResponse): boolean };
}

export type VercelHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Adapts an un-listened Fastify app into a Vercel Node function handler.
 *
 * Vercel never calls `app.listen()` — it invokes the module's default export
 * once per request with a Node request/response pair, so the app has to be
 * dispatched onto that pair instead of a bound socket (see
 * https://vercel.com/docs/frameworks/backend/fastify). Plugin boot starts
 * eagerly so it overlaps cold-start init rather than delaying the first
 * request; every request still awaits it, so a failed boot surfaces as a
 * failed invocation instead of being dropped.
 */
export function createVercelHandler(app: ServerlessApp): VercelHandler {
  const ready = Promise.resolve(app.ready());
  // Boot starts before any request has attached a handler to `ready`; without
  // this a boot failure is an unhandled rejection that kills the container
  // before the real error can be reported by the first invocation.
  ready.catch(() => undefined);

  return async (req, res) => {
    await ready;
    app.server.emit('request', req, res);
  };
}

/**
 * Port handed to the service env loaders on Vercel. Every service's env
 * schema requires `PORT` (packages/config's `httpEnvSchema` has no default),
 * but a function never binds one, so this only has to satisfy validation.
 */
export const SERVERLESS_PLACEHOLDER_PORT = '3000';

/**
 * Env source for a service's `load<Name>ServiceEnv()`. Outside Vercel it is
 * `source` untouched, so local dev and tests keep strict validation; on Vercel
 * it supplies `PORT` when none is configured. Everything else (DATABASE_URL,
 * SUPABASE_URL, ...) is genuine configuration and still fails fast if absent.
 */
export function withServerlessEnvDefaults(
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  if (!source.VERCEL) return source;
  return { ...source, PORT: source.PORT ?? SERVERLESS_PLACEHOLDER_PORT };
}
