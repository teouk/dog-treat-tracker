import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ensureSchema } from '@/lib/migrate';
import { isEbayConnected, ebayConfigured, EBAY_ENVIRONMENT } from '@/lib/ebay';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  return NextResponse.json({
    configured: ebayConfigured(),
    connected: await isEbayConnected(),
    environment: EBAY_ENVIRONMENT,
  });
}
