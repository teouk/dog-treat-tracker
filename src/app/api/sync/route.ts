export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { fetchAmazonInventory } from '@/lib/amazon';
import { getDb } from '@/lib/db';
import { auth } from '@/auth';

/**
 * Daily Amazon sync. Triggered by:
 *  - Vercel cron (sends `Authorization: Bearer ${CRON_SECRET}` automatically)
 *  - An authenticated user from the UI
 *
 * No referer or user-agent based auth — both are trivially forged.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  // Cron path: valid only when CRON_SECRET is configured AND the header matches.
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  // User path: valid NextAuth session.
  let isAuthorisedUser = false;
  if (!isCron) {
    const session = await auth();
    isAuthorisedUser = !!session;
  }

  if (!isCron && !isAuthorisedUser) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const liveData = await fetchAmazonInventory();

    if (!liveData || liveData.length === 0) {
      throw new Error('Amazon returned no items. Check API permissions.');
    }

    const syncTime = new Date().toISOString();

    const sql = getDb();
    for (const item of liveData) {
      await sql`
        INSERT INTO inventory (sku, product_name, fba_quantity, last_sync_at)
        VALUES (${item.sku}, ${item.product_name}, ${item.fulfillable}, ${syncTime})
        ON CONFLICT (sku) DO UPDATE SET
          product_name = EXCLUDED.product_name,
          fba_quantity = EXCLUDED.fba_quantity,
          last_sync_at = EXCLUDED.last_sync_at
      `;
    }

    return NextResponse.json({
      success: true,
      count: liveData.length,
      timestamp: syncTime,
      triggeredBy: isCron ? 'cron' : 'user',
    });
  } catch (error: any) {
    console.error('Sync Route Crash:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
