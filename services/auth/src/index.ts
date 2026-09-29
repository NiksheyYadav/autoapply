import type { IncomingMessage, ServerResponse } from 'node:http';

// TEMPORARY diagnostic build — isolates which init step crashes on Vercel's
// runtime (no accessible logs on this plan tier; surface it in the response
// body instead). Reverting immediately after reading the result.
export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const report: Record<string, unknown> = {
    env: {
      SUPABASE_URL: process.env.SUPABASE_URL ?? null,
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      NODE_ENV: process.env.NODE_ENV ?? null,
      AUTH_SERVICE_PORT: process.env.AUTH_SERVICE_PORT ?? null,
      VERCEL: process.env.VERCEL ?? null,
    },
  };

  try {
    const { loadAuthServiceEnv } = await import('./env.js');
    const env = loadAuthServiceEnv();
    report.envLoaded = { PORT: env.PORT, CORS_ORIGINS: env.CORS_ORIGINS };
  } catch (err) {
    report.envLoadError = err instanceof Error ? { message: err.message, stack: err.stack } : String(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(report, null, 2));
    return;
  }

  try {
    const { createDatabase } = await import('@atlas/db');
    const { close } = createDatabase({ url: process.env.DATABASE_URL!, maxConnections: 1 });
    report.dbClientCreated = true;
    await close();
  } catch (err) {
    report.dbClientError = err instanceof Error ? { message: err.message, stack: err.stack } : String(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(report, null, 2));
    return;
  }

  try {
    const { createTokenVerifierConfig } = await import('@atlas/auth-kit');
    createTokenVerifierConfig({ SUPABASE_URL: process.env.SUPABASE_URL! });
    report.tokenVerifierCreated = true;
  } catch (err) {
    report.tokenVerifierError = err instanceof Error ? { message: err.message, stack: err.stack } : String(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(report, null, 2));
    return;
  }

  try {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.get('/x', async () => ({ ok: true }));
    await app.ready();
    report.fastifyReady = true;
    await app.close();
  } catch (err) {
    report.fastifyError = err instanceof Error ? { message: err.message, stack: err.stack } : String(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(report, null, 2));
    return;
  }

  report.allStepsOk = true;
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(report, null, 2));
}
