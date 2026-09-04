export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { runFastSync, NoSkusError } from '@/lib/sync';
import { syncWorkbookAfterStockChange } from '@/lib/workbook/auto-sync';

export const maxDuration = 60;

/**
 * Nightly Amazon stock refresh. Triggered by Vercel cron (which sends
 * `Authorization: Bearer ${CRON_SECRET}`) or by a signed-in user.
 *
 * Runs the same code path as the in-app refresh button so the two can
 * never disagree about stock levels.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`;

  if (!isCron) {
    const session = await auth();
    if (!session) return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const result = await runFastSync();
    const workbook = await syncWorkbookAfterStockChange(
      isCron ? 'nightly Amazon sync' : 'Amazon fast sync',
      isCron ? 'cron' : null,
    );
    return NextResponse.json({ ...result, triggeredBy: isCron ? 'cron' : 'user', workbook });
  } catch (err) {
    if (err instanceof NoSkusError) {
      return NextResponse.json({ success: false, error: 'NO_SKUS', message: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Sync Route Crash:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
