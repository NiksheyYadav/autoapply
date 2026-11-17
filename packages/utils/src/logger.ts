import { pino, type DestinationStream, type Logger } from 'pino';
import { REDACTED } from './redact.js';

export type { Logger };

export interface LoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
  /** Where lines go; stdout when omitted. For tests that read what was logged. */
  destination?: DestinationStream;
}

/**
 * Structured JSON logs with trace propagation (docs/10 § Observability).
 * Redaction is configured here so no service can log a secret by accident.
 */
export function createLogger({ service, level = 'info', pretty = false, destination }: LoggerOptions): Logger {
  return pino(
    {
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
        // The same secrets one level down, in request-shaped objects and in a bare `headers`.
        'authorization',
        'cookie',
        'headers.authorization',
        'headers.cookie',
        'headers["x-api-key"]',
        '*.authorization',
        '*.cookie',
        '*.headers.authorization',
        '*.headers.cookie',
        '*.headers["x-api-key"]',
        '*.token',
        '*.secret',
        '*.api_key',
        '*.client_secret',
        '*.private_key',
        // A resume's text is personal data and can be 200,000 characters of it.
        'parsed_text',
        '*.parsed_text',
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
    },
    destination,
  );
}

/** A logger that discards everything. Used by tests and by dry-run workers. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
