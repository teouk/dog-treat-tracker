import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getShopifyToken } from '@/lib/shopify';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = await getShopifyToken();
  return NextResponse.json({ connected: !!token });
}
