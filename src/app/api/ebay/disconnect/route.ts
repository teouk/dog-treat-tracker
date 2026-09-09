import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ensureSchema } from '@/lib/migrate';
import { clearEbayTokens } from '@/lib/ebay';

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  await clearEbayTokens();
  return NextResponse.json({ success: true });
}
