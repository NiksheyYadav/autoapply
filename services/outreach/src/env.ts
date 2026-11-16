import { baseEnvSchema, databaseEnvSchema, httpEnvSchema, loadEnv, messagingEnvSchema, supabaseAuthEnvSchema } from '@atlas/config';
import { z } from 'zod';

export const outreachServiceEnvSchema = z
  .object({
    ...baseEnvSchema.shape,
    ...databaseEnvSchema.shape,
    ...httpEnvSchema.shape,
    ...messagingEnvSchema.shape,
    ...supabaseAuthEnvSchema.shape,
    /**
     * Whether Atlas itself delivers messages. Off by default, and it must stay
     * off until a real transport exists: with it off, `POST /v1/messages/:id/send`
     * and `POST /v1/messages/:id/schedule` are rejected before anything is
     * claimed or written, and the only way a message becomes `sent` is the
     * user recording that they sent it themselves (`POST .../mark-sent`).
     *
     * `z.stringbool()` rejects anything it does not recognise, so a typo such
     * as `OUTREACH_DELIVERY_ENABLED=ture` fails at boot instead of silently
     * reading as "off" (or "on").
     *
     * Turning it on needs a transport that really delivers. Only `local` exists
     * (it logs and delivers nothing) and `smtp` is not implemented, so the
     * combination is refused in production below. Even with it on, nothing
     * dispatches `scheduled` messages: there is no worker.
     */
    OUTREACH_DELIVERY_ENABLED: z.stringbool().default(false),
    /**
     * `local` just logs the send (dev/test only, no external dependency). `smtp`
     * is not implemented yet — mirrors `@atlas/storage`'s `s3` driver, which
     * throws a clear error at factory time rather than pretending to work.
     */
    OUTREACH_TRANSPORT_DRIVER: z.enum(['local', 'smtp']).default('local'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.OUTREACH_DELIVERY_ENABLED && env.OUTREACH_TRANSPORT_DRIVER === 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['OUTREACH_DELIVERY_ENABLED'],
        message:
          'cannot be true in production with OUTREACH_TRANSPORT_DRIVER=local: the local transport only logs, so users would be told mail was sent that never was. Leave it false until a real transport exists.',
      });
    }
  });

export type OutreachServiceEnv = z.infer<typeof outreachServiceEnvSchema>;

export function loadOutreachServiceEnv(
  source: Record<string, string | undefined> = process.env,
): OutreachServiceEnv {
  const normalized = { ...source, PORT: source.PORT ?? source.OUTREACH_SERVICE_PORT };
  return loadEnv('outreach-service', outreachServiceEnvSchema, normalized);
}
