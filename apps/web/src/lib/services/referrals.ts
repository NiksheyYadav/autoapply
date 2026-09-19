import type { ListReferralsResponse } from '@atlas/types';
import { apiFetch } from '../api.js';
import { SERVICE_URLS } from '../config.js';

export function listReferrals(accessToken: string): Promise<ListReferralsResponse> {
  return apiFetch<ListReferralsResponse>(SERVICE_URLS.referrals, '/v1/referrals', { accessToken });
}
