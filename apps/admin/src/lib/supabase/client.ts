import { createBrowserClient } from '@supabase/ssr';

/** For client components. Session is stored in cookies (not localStorage), managed by @supabase/ssr. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
