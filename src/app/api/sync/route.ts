export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { fetchAmazonInventory } from '@/lib/amazon';
import { getDb } from '@/lib/db';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const userAgent = request.headers.get('user-agent');
  const referer = request.headers.get('referer');

  // 1. Check for Vercel Cron
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}` || userAgent?.includes('vercel-cron');

  // 2. Check for Manual Sync (Checking if request comes from YOUR app domain)
  // We check if the referer exists and isn't a random outside site
  const isManual = referer && (
    referer.includes('localhost') || 
    referer.includes('vercel.app') || 
    referer.includes('glorious-dog-chews') // Add your specific project name slug here
  );

  // LOG FOR DEBUGGING (You can see this in Vercel Dashboard > Logs)
  console.log(`Sync attempt - Cron: ${isCron}, Manual: ${isManual}, Referer: ${referer}`);

  if (!isCron && !isManual && process.env.NODE_ENV === 'production') {
    return new NextResponse('Unauthorized: Security Block', { status: 401 });
  }

  try {
    const liveData = await fetchAmazonInventory();

    if (!liveData || liveData.length === 0) {
      throw new Error("Amazon returned no items. Check API permissions.");
    }

    // Capture the exact moment of sync
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
      timestamp: syncTime 
    });

  } catch (error: any) {
    console.error("Sync Route Crash:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}