export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { syncStockToWorkbook } from '@/lib/workbook/stock-sync';
import { WorkbookUnavailableError } from '@/lib/workbook/store';

export const maxDuration = 60;

/**
 * GET  — dry run. Reports the resolved column mapping, every row that would
 *        change, and both money totals, without touching the file. This is
 *        the endpoint to check after the owner renames a column.
 * POST  — apply the sync.
 *
 * Both accept the nightly cron's bearer token as well as a signed-in user,
 * matching /api/sync.
 */
async function authorize(request: NextRequest): Promise<{ ok: boolean; actor: string | null; via: string }> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`) {
    return { ok: true, actor: 'cron', via: 'cron' };
  }
  const session = await auth();
  if (!session) return { ok: false, actor: null, via: 'none' };
  return { ok: true, actor: session.user?.email ?? null, via: 'user' };
}

async function run(request: NextRequest, dryRun: boolean) {
  const { ok, actor, via } = await authorize(request);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const result = await syncStockToWorkbook({
      dryRun,
      actor,
      reason: dryRun ? 'dry run' : `manual sync (${via})`,
    });
    return NextResponse.json({ ...result, triggeredBy: via });
  } catch (error) {
    if (error instanceof WorkbookUnavailableError) {
      return NextResponse.json(
        { success: false, error: 'WORKBOOK_UNAVAILABLE', message: error.message },
        { status: 503 }
      );
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Workbook sync failed:', message);
    // A header that could not be resolved is a configuration problem the
    // owner can fix, so the message is returned rather than swallowed.
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return run(request, true);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  return run(request, body?.dryRun === true);
}
