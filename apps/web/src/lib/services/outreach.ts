import type { ListMessagesResponse } from '@atlas/types';
import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

export function listMessages(accessToken: string): Promise<ListMessagesResponse> {
  return apiFetch<ListMessagesResponse>(SERVICE_URLS.outreach, '/v1/messages', { accessToken });
}
