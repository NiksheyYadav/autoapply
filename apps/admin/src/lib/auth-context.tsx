'use client';

import type { MemberRole, PublicUser } from '@atlas/types';
import type { Session } from '@supabase/supabase-js';
import * as React from 'react';
import * as authApi from './services/auth';
import { createClient } from './supabase/client';

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

  const value = React.useMemo<SessionContextValue>(() => ({ ...state, login, logout }), [state, login, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within a SessionProvider');
  return context;
}
