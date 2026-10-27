import { createTokenVerifierConfig } from '@atlas/auth-kit';
import { createDatabase } from '@atlas/db';
import { createBroker } from '@atlas/messaging';
import { createLogger, createVercelHandler, withServerlessEnvDefaults } from '@atlas/utils';
import { buildApp } from './app.js';
import { loadLearningServiceEnv } from './env.js';
import { registerConsumers } from './worker.js';

const env = loadLearningServiceEnv(withServerlessEnvDefaults());
const logger = createLogger({ service: 'learning-service', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
const { db, sql, close } = createDatabase({ url: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_MAX });
const broker = createBroker({
  driver: env.MESSAGING_DRIVER,
  url: env.RABBITMQ_URL,
  exchange: env.MESSAGING_EXCHANGE,
  maxRetries: env.MESSAGING_MAX_RETRIES,
  logger,
});
const tokenVerifier = createTokenVerifierConfig(env);

export const app = buildApp({ db, sql, env, logger, broker, tokenVerifier });
// Consumers register in every runtime, as before. A failed subscription fails
// module load loudly, the same way a bad config does.
const subscriptions = await registerConsumers({ db, broker, logger });

// Vercel invokes this module as a serverless request handler — it never calls
// app.listen(), so requests are dispatched onto the app directly.
export default createVercelHandler(app);

if (!process.env.VERCEL) {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
    await app.close();
    await broker.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.HOST, port: env.PORT });
}
