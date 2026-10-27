'use client';

import type { MemberRole, PublicUser } from '@atlas/types';
import type { Session } from '@supabase/supabase-js';
import * as React from 'react';
import * as authApi from './services/auth';
import { createClient } from './supabase/client';

interface SessionState {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  user: PublicUser | null;
  /**
   * `role` and `organizationId` are the claims of the access token (the user's
   * oldest membership), echoed by /v1/auth/me. They are a navigation hint only;
   * the admin API re-checks the real membership on every request.
   */
  role: MemberRole | null;
  organizationId: string | null;
  accessToken: string | null;
}

interface SessionContextValue extends SessionState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * A token that is valid right now. Prefer this over `accessToken` for
   * requests: the Supabase client refreshes an expiring token here, whereas
   * the state value is only updated when the auth listener fires.
   */
  getAccessToken: () => Promise<string | null>;
}

const EMPTY_STATE: SessionState = { status: 'unauthenticated', user: null, role: null, organizationId: null, accessToken: null };

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [supabase] = React.useState(() => createClient());
  const [state, setState] = React.useState<SessionState>({ ...EMPTY_STATE, status: 'loading' });

  const applySession = React.useCallback(
    async (session: Session | null) => {
      if (!session) {
        setState({ ...EMPTY_STATE, status: 'unauthenticated' });
        return;
      }
      try {
        const profile = await authApi.me(session.access_token);
        setState({
          status: 'authenticated',
          user: profile.user,
          role: profile.role,
          organizationId: profile.organization_id,
          accessToken: session.access_token,
        });
      } catch {
        setState({ ...EMPTY_STATE, status: 'unauthenticated' });
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

  const logout = React.useCallback(async () => {
    await supabase.auth.signOut();
    setState({ ...EMPTY_STATE, status: 'unauthenticated' });
  }, [supabase]);

  const getAccessToken = React.useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, [supabase]);

  const value = React.useMemo<SessionContextValue>(
    () => ({ ...state, login, logout, getAccessToken }),
    [state, login, logout, getAccessToken],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within a SessionProvider');
  return context;
}
