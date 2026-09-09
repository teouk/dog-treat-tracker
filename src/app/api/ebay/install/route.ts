import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ensureSchema } from '@/lib/migrate';
import { storeOAuthState } from '@/lib/security';
import { buildConsentUrl, ebayConfigured } from '@/lib/ebay';

/** Starts the eBay consent flow. */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.redirect(new URL('/', request.url));

  if (!ebayConfigured()) {
    return NextResponse.json(
      { error: 'eBay is not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_REDIRECT_URI (the RuName).' },
      { status: 500 }
    );
  }

  await ensureSchema();
  // Same one-shot nonce scheme the Shopify flow uses.
  const nonce = await storeOAuthState('ebay');
  return NextResponse.redirect(buildConsentUrl(nonce));
}
