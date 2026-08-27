import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ensureSchema } from '@/lib/migrate';
import { isDeductionEnabled, setDeductionEnabled } from '@/lib/outbound';

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  return NextResponse.json({
    deductOutboundAmazon: await isDeductionEnabled('amazon'),
    deductOutboundShopify: await isDeductionEnabled('shopify'),
  });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  const body = await request.json().catch(() => ({}));

  if (typeof body.deductOutboundAmazon === 'boolean') {
    await setDeductionEnabled('amazon', body.deductOutboundAmazon);
  }
  if (typeof body.deductOutboundShopify === 'boolean') {
    await setDeductionEnabled('shopify', body.deductOutboundShopify);
  }

  return NextResponse.json({
    deductOutboundAmazon: await isDeductionEnabled('amazon'),
    deductOutboundShopify: await isDeductionEnabled('shopify'),
  });
}
