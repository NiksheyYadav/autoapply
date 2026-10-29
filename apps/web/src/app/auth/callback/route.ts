import { NextResponse } from 'next/server';
import { safeNextPath } from '@/lib/safe-redirect';
import { createClient } from '@/lib/supabase/server';

/** The page the password-recovery email link is sent to (see requestPasswordReset in auth-context.tsx). */
const RESET_PASSWORD_PATH = '/reset-password';

/**
 * Builds a redirect that is guaranteed to stay on this origin. `path` is
 * already validated by safeNextPath; resolving it against `origin` and
 * comparing origins again keeps that guarantee even if the validator is ever
 * loosened.
 */
function redirectWithinOrigin(origin: string, path: string): NextResponse {
  const target = new URL(path, origin);
  if (target.origin !== origin) return NextResponse.redirect(new URL('/dashboard', origin));
  return NextResponse.redirect(target);
}

/**
 * Supabase's OAuth, email-confirmation and password-recovery flows all land
 * here with `?code=` in the query string (not a URL fragment) — exchanged for
 * a session server-side, so the session cookie is set before the browser ever
 * sees the next page. Replaces the old fragment-parsing /oauth/callback page
 * from the auth-service era.
 *
 * `next` is where to go afterwards; it must be a same-origin path, otherwise
 * it is ignored (see safeNextPath). A recovery link sets next=/reset-password,
 * so the user arrives there already holding a recovery session.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeNextPath(searchParams.get('next'));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return redirectWithinOrigin(origin, next);
    }
  }

  // Reaching here means the code was missing, expired, already used, or (PKCE)
  // the link was opened in a different browser from the one that asked for
  // it. A recovery link goes back to "request a new link"; anything else
  // goes to sign-in.
  if (next === RESET_PASSWORD_PATH) {
    return redirectWithinOrigin(origin, '/forgot-password?error=link_invalid');
  }
  return redirectWithinOrigin(origin, '/login?oauth_error=session');
}
