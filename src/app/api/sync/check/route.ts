import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken } from '@/lib/amazon';
import { auth } from '@/auth';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const reportId = request.nextUrl.searchParams.get('reportId');
  const token = await getAccessToken();
  const res = await fetch(`https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/reports/${reportId}`, {
    headers: { 'x-amz-access-token': token }
  });
  const data = await res.json();
  return NextResponse.json({ 
    ready: data.processingStatus === 'DONE', 
    reportDocumentId: data.reportDocumentId 
  });
}