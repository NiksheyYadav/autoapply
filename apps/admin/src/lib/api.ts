import type { ErrorResponse } from '@atlas/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  accessToken?: string | null;
  headers?: Record<string, string>;
}

/** Shared fetch wrapper: JSON in, JSON out, and the docs/04 error envelope surfaces as an ApiError. */
export async function apiFetch<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const errorBody = data as ErrorResponse | undefined;
    throw new ApiError(res.status, errorBody?.error.code ?? 'INTERNAL_ERROR', errorBody?.error.message ?? res.statusText);
  }

  return data as T;
}
