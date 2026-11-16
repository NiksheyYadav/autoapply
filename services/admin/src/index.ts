import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase } from '@atlas/db';
import { createLogger, createVercelHandler, withServerlessEnvDefaults } from '@atlas/utils';
import { buildApp } from './app.js';
import { loadAdminServiceEnv } from './env.js';

const env = loadAdminServiceEnv(withServerlessEnvDefaults());
const logger = createLogger({
  service: 'admin-service',
  level: env.LOG_LEVEL,
  pretty: env.LOG_PRETTY,
});
const { db, sql, close } = createDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_POOL_MAX,
});
const tokenVerifier = createTokenVerifierConfig(env);

export const app = buildApp({ db, sql, env, logger, tokenVerifier });

// Vercel invokes this module as a serverless request handler — it never calls
// app.listen(), so requests are dispatched onto the app directly.
export default createVercelHandler(app);

if (!process.env.VERCEL) {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.HOST, port: env.PORT });
}
