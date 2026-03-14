import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken } from '@/lib/amazon';

export async function GET() {
  const token = await getAccessToken();
  const res = await fetch(`https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
      marketplaceIds: ['A1F83G8C2ARO7P']
    }),
  });
  const data = await res.json();
  return NextResponse.json({ reportId: data.reportId });
}