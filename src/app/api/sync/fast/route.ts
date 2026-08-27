import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { runFastSync, NoSkusError } from '@/lib/sync';

export const maxDuration = 30;

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    return NextResponse.json(await runFastSync());
  } catch (err) {
    if (err instanceof NoSkusError) {
      return NextResponse.json({ error: 'NO_SKUS', message: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
