import { LLMS_TXT } from '../../lib/seo';

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(LLMS_TXT, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
