import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { clearShopifyToken } from '@/lib/shopify';

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await clearShopifyToken();
  return NextResponse.json({ success: true });
}
