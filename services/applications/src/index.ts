import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase } from '@atlas/db';
import { createBroker } from '@atlas/messaging';
import { createLogger } from '@atlas/utils';
import { buildApp } from './app.js';
import { loadApplicationsServiceEnv } from './env.js';

async function main(): Promise<void> {
  const env = loadApplicationsServiceEnv();
  const logger = createLogger({ service: 'applications-service', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  const { db, sql, close } = createDatabase({ url: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_MAX });
  const broker = createBroker({
    driver: env.MESSAGING_DRIVER,
    url: env.RABBITMQ_URL,
    exchange: env.MESSAGING_EXCHANGE,
    maxRetries: env.MESSAGING_MAX_RETRIES,
    logger,
  });
  const tokenVerifier = createTokenVerifierConfig(env);

  const app = buildApp({ db, sql, env, logger, broker, tokenVerifier });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await broker.close();
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
