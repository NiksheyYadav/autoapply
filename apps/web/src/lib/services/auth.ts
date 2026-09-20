import type { AuthSessionResponse, LoginRequest, MemberRole, Permissions, PublicUser, RegisterRequest, TokenPair } from '@atlas/types';
import { apiFetch } from '../api';
import { SERVICE_URLS } from '../config';

export function register(input: RegisterRequest): Promise<AuthSessionResponse> {
  return apiFetch<AuthSessionResponse>(SERVICE_URLS.auth, '/v1/auth/register', { method: 'POST', body: input });
}

export function login(input: LoginRequest): Promise<AuthSessionResponse> {
  return apiFetch<AuthSessionResponse>(SERVICE_URLS.auth, '/v1/auth/login', { method: 'POST', body: input });
}

export function refresh(refreshToken: string): Promise<TokenPair> {
  return apiFetch<TokenPair>(SERVICE_URLS.auth, '/v1/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } });
}

export interface MeResponse {
  user: PublicUser;
  organization_id: string | null;
  role: MemberRole | null;
  permissions: Permissions;
}

export function me(accessToken: string): Promise<MeResponse> {
  return apiFetch<MeResponse>(SERVICE_URLS.auth, '/v1/auth/me', { accessToken });
}

export function logout(accessToken: string): Promise<void> {
  return apiFetch<void>(SERVICE_URLS.auth, '/v1/auth/logout', { method: 'POST', accessToken });
}
