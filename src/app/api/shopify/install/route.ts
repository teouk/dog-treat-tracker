import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_SCOPES } from '@/lib/shopify';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!SHOPIFY_STORE || !SHOPIFY_CLIENT_ID) {
    return NextResponse.json({ error: 'Shopify env vars not configured' }, { status: 500 });
  }

  const baseUrl = request.nextUrl.origin;
  const redirectUri = `${baseUrl}/api/shopify/callback`;
  const state = Math.random().toString(36).substring(2);

  const installUrl =
    `https://${SHOPIFY_STORE}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  return NextResponse.redirect(installUrl);
}
