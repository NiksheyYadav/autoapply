import { pino, type Logger } from 'pino';
import { REDACTED } from './redact.js';

export type { Logger };

export interface LoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
}

/**
 * Structured JSON logs with trace propagation (docs/10 § Observability).
 * Redaction is configured here so no service can log a secret by accident.
 */
export function createLogger({ service, level = 'info', pretty = false }: LoggerOptions): Logger {
  return pino({
    level,
    base: { service },
    redact: {
      paths: [
        'password',
        'password_hash',
        'token',
        'access_token',
        'refresh_token',
        'secret',
        'api_key',
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.access_token',
        '*.refresh_token',
      ],
      censor: REDACTED,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

/** A logger that discards everything. Used by tests and by dry-run workers. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
