'use client';

import type { MemberRole, PublicUser } from '@atlas/types';
import * as React from 'react';
import * as authApi from './services/auth';

/**
 * Refresh token in localStorage, access token in memory only — same MVP
 * tradeoff as apps/web's auth-context.tsx (no API gateway/BFF exists yet).
 */
const REFRESH_TOKEN_KEY = 'atlas-admin.refresh_token';

interface SessionState {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  user: PublicUser | null;
  role: MemberRole | null;
  organizationId: string | null;
  accessToken: string | null;
}

interface SessionContextValue extends SessionState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const EMPTY_STATE: SessionState = { status: 'unauthenticated', user: null, role: null, organizationId: null, accessToken: null };

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<SessionState>({ ...EMPTY_STATE, status: 'loading' });

  const hydrate = React.useCallback(async () => {
    const storedRefreshToken = typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!storedRefreshToken) {
      setState({ ...EMPTY_STATE, status: 'unauthenticated' });
      return;
    }
    try {
      const tokens = await authApi.refresh(storedRefreshToken);
      localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
      const profile = await authApi.me(tokens.access_token);
      setState({
        status: 'authenticated',
        user: profile.user,
        role: profile.role,
        organizationId: profile.organization_id,
        accessToken: tokens.access_token,
      });
    } catch {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      setState({ ...EMPTY_STATE, status: 'unauthenticated' });
    }
  }, []);

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const login = React.useCallback(async (email: string, password: string) => {
    const session = await authApi.login({ email, password });
    localStorage.setItem(REFRESH_TOKEN_KEY, session.tokens.refresh_token);
    const profile = await authApi.me(session.tokens.access_token);
    setState({
      status: 'authenticated',
      user: session.user,
      role: profile.role,
      organizationId: session.organization_id,
      accessToken: session.tokens.access_token,
    });
  }, []);

  const logout = React.useCallback(async () => {
    if (state.accessToken) {
      await authApi.logout(state.accessToken).catch(() => undefined);
    }
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    setState({ ...EMPTY_STATE, status: 'unauthenticated' });
  }, [state.accessToken]);

  const value = React.useMemo<SessionContextValue>(() => ({ ...state, login, logout }), [state, login, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within a SessionProvider');
  return context;
}
