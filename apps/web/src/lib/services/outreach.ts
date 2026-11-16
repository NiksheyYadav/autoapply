import type { ListMessagesResponse, MessageResponse } from '@atlas/types';
import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

export function listMessages(accessToken: string): Promise<ListMessagesResponse> {
  return apiFetch<ListMessagesResponse>(SERVICE_URLS.outreach, '/v1/messages', { accessToken });
}

/**
 * Records that the person sent this message themselves. Atlas delivers
 * nothing; this only updates the status. Repeating it is safe: an already
 * recorded message comes back unchanged.
 */
export function markMessageSent(accessToken: string, messageId: string): Promise<MessageResponse> {
  return apiFetch<MessageResponse>(SERVICE_URLS.outreach, `/v1/messages/${encodeURIComponent(messageId)}/mark-sent`, {
    method: 'POST',
    accessToken,
  });
}
