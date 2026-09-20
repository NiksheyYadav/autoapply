import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase } from '@atlas/db';
import { createLogger } from '@atlas/utils';
import { buildApp } from './app.js';
import { loadConnectorsServiceEnv } from './env.js';
import { createSecretStore } from './lib/secret-store.js';

async function main(): Promise<void> {
  const env = loadConnectorsServiceEnv();
  const logger = createLogger({ service: 'connectors-service', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  const { db, sql, close } = createDatabase({ url: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_MAX });
  const tokenVerifier = createTokenVerifierConfig(env);
  const secretStore = createSecretStore({ driver: env.SECRET_STORE_DRIVER, localRoot: env.SECRET_STORE_LOCAL_ROOT });

  const app = buildApp({ db, sql, env, logger, tokenVerifier, secretStore });

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

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
