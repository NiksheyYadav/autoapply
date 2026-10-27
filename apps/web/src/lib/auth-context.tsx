'use client';

import type { PublicUser } from '@atlas/types';
import type { Session } from '@supabase/supabase-js';
import * as React from 'react';
import { ApiError } from './api';
import * as authApi from './services/auth';
import { createClient } from './supabase/client';

export type OAuthProvider = 'google' | 'azure' | 'github';

interface SessionState {
  /**
   * `unavailable` means Supabase holds a session for this browser but our own
   * backend couldn't be asked who it belongs to (outage, network). That is not
   * the same as signed out, and treating it so would log everyone out whenever
   * the API hiccups.
   */
  status: 'loading' | 'authenticated' | 'unauthenticated' | 'unavailable';
  user: PublicUser | null;
  accessToken: string | null;
}

export interface RegisterInput {
  email: string;
  password: string;
  full_name: string;
}

export interface RegisterResult {
  /**
   * True when Supabase created the account but returned no session — i.e.
   * email confirmation is on and the user must click the emailed link first.
   * Also true for an address that is already registered (Supabase hides that
   * on purpose), so callers must not treat it as proof the address is new.
   */
  needsEmailConfirmation: boolean;
}

interface SessionContextValue extends SessionState {
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<RegisterResult>;
  /** Re-sends the signup confirmation email. */
  resendConfirmation: (email: string) => Promise<void>;
  /** Emails a password-reset link. Resolves the same way whether or not the address has an account. */
  requestPasswordReset: (email: string) => Promise<void>;
  /** Sets a new password on the current session (the recovery session, after following a reset link). */
  updatePassword: (password: string) => Promise<void>;
  /** 'azure' is Supabase's provider id for Microsoft — not our own naming. */
  signInWithOAuth: (provider: OAuthProvider) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-checks the session after an `unavailable` result. */
  retry: () => Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

const SIGNED_OUT: SessionState = { status: 'unauthenticated', user: null, accessToken: null };

/**
 * Supabase answers rate-limited auth-email requests with 429 / an
 * `over_*_rate_limit` code. Those only happen for addresses that exist, so the
 * password-reset and resend flows swallow them: showing a different message
 * would let anyone probe which emails are registered.
 */
function isRateLimited(error: { status?: number; code?: string }): boolean {
  return error.status === 429 || (error.code?.includes('rate_limit') ?? false);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [supabase] = React.useState(() => createClient());
  const [state, setState] = React.useState<SessionState>({ status: 'loading', user: null, accessToken: null });

  const applySession = React.useCallback(
    async (session: Session | null) => {
      if (!session) {
        setState(SIGNED_OUT);
        return;
      }
      // Without this, a fresh sign-in leaves the status at 'unauthenticated'
      // while /v1/auth/me is in flight, and the dashboard layout bounces the
      // user straight back to /login.
      setState((prev) => (prev.status === 'authenticated' ? prev : { status: 'loading', user: null, accessToken: null }));
      try {
        const profile = await authApi.me(session.access_token);
        setState({ status: 'authenticated', user: profile.user, accessToken: session.access_token });
      } catch (cause) {
        // Only a 401 means the session itself is no good. Anything else
        // (network, 5xx) is our backend being unreachable: keep an already
        // loaded user signed in, otherwise report the outage honestly.
        if (cause instanceof ApiError && cause.status === 401) {
          setState(SIGNED_OUT);
          return;
        }
        setState((prev) =>
          prev.user
            ? { ...prev, accessToken: session.access_token }
            : { status: 'unavailable', user: null, accessToken: session.access_token },
        );
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
      if (error) {
        if (error.code === 'email_not_confirmed') {
          throw new Error('Please confirm your email address first — check your inbox for the confirmation link.');
        }
        throw new Error(error.message);
      }
    },
    [supabase],
  );

  const register = React.useCallback(
    async (input: RegisterInput): Promise<RegisterResult> => {
      const { data, error } = await supabase.auth.signUp({
        email: input.email,
        password: input.password,
        options: {
          data: { full_name: input.full_name },
          // The confirmation link comes back through the same code exchange as OAuth.
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw new Error(error.message);
      return { needsEmailConfirmation: data.session === null };
    },
    [supabase],
  );

  const resendConfirmation = React.useCallback(
    async (email: string) => {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error && !isRateLimited(error)) {
        console.error('resend confirmation failed', error.status, error.code);
        throw new Error("We couldn't send the email just now. Please try again in a moment.");
      }
    },
    [supabase],
  );

  const requestPasswordReset = React.useCallback(
    async (email: string) => {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      if (error && !isRateLimited(error)) {
        console.error('password reset request failed', error.status, error.code);
        throw new Error("We couldn't send the email just now. Please try again in a moment.");
      }
    },
    [supabase],
  );

  const updatePassword = React.useCallback(
    async (password: string) => {
      const { error } = await supabase.auth.updateUser({ password });
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
    setState(SIGNED_OUT);
  }, [supabase]);

  const retry = React.useCallback(async () => {
    setState({ status: 'loading', user: null, accessToken: null });
    const { data } = await supabase.auth.getSession();
    await applySession(data.session);
  }, [supabase, applySession]);

  const value = React.useMemo<SessionContextValue>(
    () => ({
      ...state,
      login,
      register,
      resendConfirmation,
      requestPasswordReset,
      updatePassword,
      signInWithOAuth,
      logout,
      retry,
    }),
    [state, login, register, resendConfirmation, requestPasswordReset, updatePassword, signInWithOAuth, logout, retry],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within a SessionProvider');
  return context;
}
