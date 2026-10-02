import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Supabase's OAuth flow lands here with `?code=` in the query string (not a
 * URL fragment) — exchanged for a session server-side, so the session cookie
 * is set before the browser ever sees /dashboard. Replaces the old
 * fragment-parsing /oauth/callback page from the auth-service era.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?oauth_error=session`);
}
