import type { Message } from '@atlas/types';
import type { Logger } from '@atlas/utils';

/**
 * The actual send path is a connector concern — docs/08 gives external APIs
 * and token handling to connectors-service, not outreach-service. This
 * interface is the seam: outreach-service only ever depends on it, never on
 * a specific provider SDK, mirroring `@atlas/storage`'s `StorageDriver`.
 */
export interface OutreachTransport {
  send(message: Message): Promise<void>;
}

export interface LocalTransportOptions {
  logger: Logger;
}

/** Safe default: records that a send happened without actually delivering anything. */
export function createLocalTransport({ logger }: LocalTransportOptions): OutreachTransport {
  return {
    async send(message: Message): Promise<void> {
      logger.info(
        { messageId: message.message_id, channel: message.channel, subject: message.subject },
        'outreach message "sent" via local transport (no real delivery)',
      );
    },
  };
}

export interface CreateTransportOptions {
  driver: 'local' | 'smtp';
  logger: Logger;
}

export function createTransport(options: CreateTransportOptions): OutreachTransport {
  if (options.driver === 'local') {
    return createLocalTransport({ logger: options.logger });
  }
  throw new Error("Outreach transport 'smtp' is not implemented yet — set OUTREACH_TRANSPORT_DRIVER=local.");
}
