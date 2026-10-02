'use client';

import type { PublicUser } from '@atlas/types';
import type { Session } from '@supabase/supabase-js';
import * as React from 'react';
import * as authApi from './services/auth';
import { createClient } from './supabase/client';

export type OAuthProvider = 'google' | 'azure' | 'github';

interface SessionState {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  user: PublicUser | null;
  accessToken: string | null;
}

interface SessionContextValue extends SessionState {
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; full_name: string; organization_name?: string }) => Promise<void>;
  /** 'azure' is Supabase's provider id for Microsoft — not our own naming. */
  signInWithOAuth: (provider: OAuthProvider) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [supabase] = React.useState(() => createClient());
  const [state, setState] = React.useState<SessionState>({ status: 'loading', user: null, accessToken: null });

  const applySession = React.useCallback(
    async (session: Session | null) => {
      if (!session) {
        setState({ status: 'unauthenticated', user: null, accessToken: null });
        return;
      }
      try {
        const profile = await authApi.me(session.access_token);
        setState({ status: 'authenticated', user: profile.user, accessToken: session.access_token });
      } catch {
        setState({ status: 'unauthenticated', user: null, accessToken: null });
      }
    },
    [],
  );

  React.useEffect(() => {
    supabase.auth.getSession().then(({ data }) => void applySession(data.session));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session);
    });
    return () => subscription.unsubscribe();
  }, [supabase, applySession]);

  const login = React.useCallback(
    async (email: string, password: string) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    },
    [supabase],
  );

  const register = React.useCallback(
    async (input: { email: string; password: string; full_name: string; organization_name?: string }) => {
      const { error } = await supabase.auth.signUp({
        email: input.email,
        password: input.password,
        options: { data: { full_name: input.full_name, organization_name: input.organization_name } },
      });
      if (error) throw new Error(error.message);
    },
    [supabase],
  );

  const signInWithOAuth = React.useCallback(
    async (provider: OAuthProvider) => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw new Error(error.message);
    },
    [supabase],
  );

  const logout = React.useCallback(async () => {
    await supabase.auth.signOut();
    setState({ status: 'unauthenticated', user: null, accessToken: null });
  }, [supabase]);

  const value = React.useMemo<SessionContextValue>(
    () => ({ ...state, login, register, signInWithOAuth, logout }),
    [state, login, register, signInWithOAuth, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within a SessionProvider');
  return context;
}
