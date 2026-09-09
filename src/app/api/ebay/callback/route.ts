import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema } from '@/lib/migrate';
import { consumeOAuthState } from '@/lib/security';
import { exchangeCodeForTokens } from '@/lib/ebay';

/**
 * eBay redirects the browser here after consent.
 *
 * Unauthenticated by design — eBay drives this navigation, so the CSRF
 * `state` nonce is what proves the callback belongs to a flow we started.
 */
export async function GET(request: NextRequest) {
  await ensureSchema();
  const params = request.nextUrl.searchParams;
  const home = new URL('/', request.url);

  const declined = params.get('error');
  if (declined) {
    home.searchParams.set('ebay', 'declined');
    return NextResponse.redirect(home);
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) {
    home.searchParams.set('ebay', 'missing_code');
    return NextResponse.redirect(home);
  }

  if (!(await consumeOAuthState('ebay', state))) {
    home.searchParams.set('ebay', 'bad_state');
    return NextResponse.redirect(home);
  }

  try {
    await exchangeCodeForTokens(code);
    home.searchParams.set('ebay', 'connected');
  } catch (e) {
    console.error('[ebay] token exchange failed:', e);
    home.searchParams.set('ebay', 'token_failed');
  }
  return NextResponse.redirect(home);
}
