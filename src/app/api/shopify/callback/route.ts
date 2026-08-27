import { NextRequest, NextResponse } from 'next/server';
import { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, saveShopifyToken } from '@/lib/shopify';
import { consumeOAuthState, verifyShopifyHmac } from '@/lib/security';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get('code');
  const state = params.get('state');
  const shop = params.get('shop');

  if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  if (!state) return NextResponse.json({ error: 'Missing state' }, { status: 400 });

  // 1. Verify shop matches our configured store — reject callbacks for
  //    any other shop (defense-in-depth against confused-deputy attacks).
  if (shop && shop !== SHOPIFY_STORE) {
    return NextResponse.json({ error: 'Shop mismatch' }, { status: 400 });
  }

  // 2. Validate the HMAC signature using our client secret. This proves
  //    the callback actually came from Shopify (not a forged request).
  if (!verifyShopifyHmac(params, SHOPIFY_CLIENT_SECRET)) {
    return NextResponse.json({ error: 'Invalid HMAC signature' }, { status: 401 });
  }

  // 3. One-shot validate the state nonce. Prevents CSRF and replay.
  const stateOk = await consumeOAuthState('shopify', state);
  if (!stateOk) {
    return NextResponse.json({ error: 'Invalid or expired state' }, { status: 401 });
  }

  try {
    const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
    const data = await res.json();

    if (!data.access_token) {
      return NextResponse.json({ error: 'Token exchange failed', detail: data }, { status: 500 });
    }

    await saveShopifyToken(data.access_token, data.scope || '');

    return NextResponse.redirect(new URL('/?shopify=connected', request.url));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'Callback failed', detail }, { status: 500 });
  }
}
