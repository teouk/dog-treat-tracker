import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getShopifyToken, getShopifyScope, SHOPIFY_SCOPES } from '@/lib/shopify';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = await getShopifyToken();
  const grantedScopeStr = await getShopifyScope();
  const grantedScopes = grantedScopeStr ? grantedScopeStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const requestedScopes = SHOPIFY_SCOPES.split(',');
  const missingScopes = requestedScopes.filter(s => !grantedScopes.includes(s));

  return NextResponse.json({
    connected: !!token,
    grantedScopes,
    requestedScopes,
    missingScopes,
  });
}
