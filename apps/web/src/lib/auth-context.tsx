'use client';

import type { PublicUser } from '@atlas/types';
import * as React from 'react';
import * as authApi from './services/auth';

/**
 * Refresh token lives in localStorage and the access token only in memory —
 * a reasonable MVP tradeoff for a client-only app with no API gateway/BFF
 * yet (docs/01). A production deployment should front this with an
 * httpOnly-cookie session instead; this is not that.
 */
const REFRESH_TOKEN_KEY = 'atlas.refresh_token';

interface SessionState {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  user: PublicUser | null;
  accessToken: string | null;
}

interface SessionContextValue extends SessionState {
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; full_name: string; organization_name?: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<SessionState>({ status: 'loading', user: null, accessToken: null });

  const hydrate = React.useCallback(async () => {
    const storedRefreshToken = typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!storedRefreshToken) {
      setState({ status: 'unauthenticated', user: null, accessToken: null });
      return;
    }
    try {
      const tokens = await authApi.refresh(storedRefreshToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
      const profile = await authApi.me(tokens.access_token);
      setState({ status: 'authenticated', user: profile.user, accessToken: tokens.access_token });
    } catch {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      setState({ status: 'unauthenticated', user: null, accessToken: null });
    }
  }, []);

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const login = React.useCallback(async (email: string, password: string) => {
    const session = await authApi.login({ email, password });
    localStorage.setItem(REFRESH_TOKEN_KEY, session.tokens.refresh_token);
    setState({ status: 'authenticated', user: session.user, accessToken: session.tokens.access_token });
  }, []);

  const register = React.useCallback(
    async (input: { email: string; password: string; full_name: string; organization_name?: string }) => {
      const session = await authApi.register(input);
      localStorage.setItem(REFRESH_TOKEN_KEY, session.tokens.refresh_token);
      setState({ status: 'authenticated', user: session.user, accessToken: session.tokens.access_token });
    },
    [],
  );

  const logout = React.useCallback(async () => {
    if (state.accessToken) {
      await authApi.logout(state.accessToken).catch(() => undefined);
    }
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    setState({ status: 'unauthenticated', user: null, accessToken: null });
  }, [state.accessToken]);

  const value = React.useMemo<SessionContextValue>(
    () => ({ ...state, login, register, logout }),
    [state, login, register, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within a SessionProvider');
  return context;
}
