import { createDatabase } from '@atlas/db';
import { createLogger } from '@atlas/utils';
import { buildApp } from './app.js';
import { loadAuthServiceEnv } from './env.js';
import { createTokenConfig } from './security/tokens.js';

const env = loadAuthServiceEnv();
const logger = createLogger({ service: 'auth-service', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
const { db, sql, close } = createDatabase({ url: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_MAX });
const tokenConfig = createTokenConfig(env);

export const app = buildApp({ db, sql, env, logger, tokenConfig });

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.HOST, port: env.PORT });
