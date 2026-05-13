import { NextRequest, NextResponse } from 'next/server';
import { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, saveShopifyToken } from '@/lib/shopify';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) return NextResponse.json({ error: 'Missing code' }, { status: 400 });

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
  } catch (e: any) {
    return NextResponse.json({ error: 'Callback failed', detail: e.message }, { status: 500 });
  }
}
