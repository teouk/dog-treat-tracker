import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_SCOPES } from '@/lib/shopify';
import { storeOAuthState } from '@/lib/security';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!SHOPIFY_STORE || !SHOPIFY_CLIENT_ID) {
    return NextResponse.json({ error: 'Shopify env vars not configured' }, { status: 500 });
  }

  const baseUrl = request.nextUrl.origin;
  const redirectUri = `${baseUrl}/api/shopify/callback`;

  // Cryptographically secure state nonce, stored in DB with 10-min expiry.
  const state = await storeOAuthState('shopify');

  const installUrl =
    `https://${SHOPIFY_STORE}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  return NextResponse.redirect(installUrl);
}
