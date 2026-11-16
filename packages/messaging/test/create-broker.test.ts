import { describe, expect, it } from 'vitest';
import { createDatabase } from '@atlas/db';
import { createSilentLogger } from '@atlas/utils';
import { createBroker, isDrainableBroker, MemoryBroker, PostgresBroker } from '../src/index.js';

const logger = createSilentLogger();

describe('createBroker', () => {
  it('keeps memory as the in-process default and does not make it drainable', () => {
    const broker = createBroker({ driver: 'memory', logger });
    expect(broker).toBeInstanceOf(MemoryBroker);
    expect(isDrainableBroker(broker)).toBe(false);
  });

  it('requires a database handle for the postgres driver', () => {
    expect(() => createBroker({ driver: 'postgres', logger })).toThrow(
      /database handle is required/,
    );
  });

  it('builds a drainable postgres broker from the service database handle', () => {
    // postgres.js connects lazily, so no database needs to be running.
    const handle = createDatabase({ url: 'postgres://atlas:atlas@127.0.0.1:1/unused' });
    try {
      const broker = createBroker({ driver: 'postgres', db: handle.db, maxRetries: 2, logger });
      expect(broker).toBeInstanceOf(PostgresBroker);
      expect(isDrainableBroker(broker)).toBe(true);
      expect(broker.isHealthy()).toBe(true);
    } finally {
      void handle.close();
    }
  });

  it('still insists on RABBITMQ_URL for the rabbitmq driver', () => {
    expect(() => createBroker({ driver: 'rabbitmq', logger })).toThrow(/RABBITMQ_URL/);
  });
});
