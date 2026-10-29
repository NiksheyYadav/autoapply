export interface AuthProbe {
  service: string;
  path: string;
}
export type Verdict = { result: 'pass' | 'warn' | 'fail'; note: string };

export const AUTH_PROBES: readonly AuthProbe[];
export const DRAIN_SERVICES: readonly string[];
export const PROTECTED_JOB_ROUTES: readonly AuthProbe[];
export const WEB_PATHS: readonly string[];

export function serviceOrigin(service: string, env: Record<string, string | undefined>): string | undefined;
export function classifyAuthProbe(response: { status: number; contentType?: string; body?: string }): Verdict;
export function classifyDrainProbe(response: { status: number; authenticated: boolean }): Verdict;
