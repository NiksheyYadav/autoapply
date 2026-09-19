import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '@atlas/utils';
import { createTransport } from '../src/lib/transport.js';

describe('createTransport', () => {
  it('local transport logs and never throws', async () => {
    const logger = createSilentLogger();
    const infoSpy = vi.spyOn(logger, 'info');
    const transport = createTransport({ driver: 'local', logger });
    await expect(
      transport.send({
        message_id: 'm1',
        application_id: null,
        contact_id: null,
        user_id: 'u1',
        channel: 'email',
        status: 'draft',
        subject: 'hi',
        body: 'hello',
        idempotency_key: 'k'.repeat(8),
        scheduled_for: null,
        sent_at: null,
        created_at: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalled();
  });

  it('smtp is not implemented yet', () => {
    expect(() => createTransport({ driver: 'smtp', logger: createSilentLogger() })).toThrow(/not implemented yet/);
  });
});
