import { NextRequest, NextResponse } from 'next/server';
import { fetchAmazonInventory } from '@/lib/amazon';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase (Use service role key for backend sync)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if(authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const liveData = await fetchAmazonInventory();

    // Loop through each item from Amazon and update our DB
    for (const item of liveData) {
      await supabase
        .from('inventory')
        .upsert({
          sku: item.sku,
          product_name: item.product_name,
          amazon_fulfillable: item.fulfillable,
          amazon_inbound: item.inbound,
          last_sync_at: new Date().toISOString(),
        }, { onConflict: 'sku' });
    }

    return NextResponse.json({ success: true, message: 'Inventory Synced!' });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}