import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

export const dynamic = 'force-dynamic';

/**
 * eBay Marketplace Account Deletion / Closure notification endpoint.
 *
 * eBay disables every production keyset until this exists and validates, so
 * it is a gate on the integration rather than an optional extra.
 *
 * Deliberately unauthenticated: eBay calls it directly with no credentials of
 * ours, so requiring a session would make validation fail. It is safe to leave
 * open because it performs no action — see the POST handler.
 */

/**
 * Must match the token entered in the eBay developer portal exactly.
 * eBay's rules: 32-80 characters, alphanumeric plus underscore and hyphen.
 */
const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || '';

/**
 * Must match the endpoint URL registered with eBay character for character,
 * because it is hashed. Falling back to the request's own URL is close enough
 * in practice but breaks if the app is reached through a second alias, so the
 * env var is the source of truth.
 */
function endpointUrl(request: NextRequest): string {
  return process.env.EBAY_DELETION_ENDPOINT
    || `${request.nextUrl.origin}${request.nextUrl.pathname}`;
}

/**
 * Validation handshake.
 *
 * eBay GETs the endpoint with a one-off `challenge_code` and expects the
 * SHA-256 of challengeCode + verificationToken + endpoint, hex encoded, in
 * that exact order. Any other order, or an endpoint string that differs from
 * the registered one by so much as a trailing slash, produces a valid-looking
 * hash that eBay rejects without explanation.
 */
export async function GET(request: NextRequest) {
  const challengeCode = request.nextUrl.searchParams.get('challenge_code');
  if (!challengeCode) {
    return NextResponse.json({ error: 'challenge_code is required' }, { status: 400 });
  }
  if (!VERIFICATION_TOKEN) {
    console.error('[ebay] EBAY_VERIFICATION_TOKEN is not set — cannot answer the challenge.');
    return NextResponse.json({ error: 'Endpoint is not configured' }, { status: 500 });
  }

  const endpoint = endpointUrl(request);
  const challengeResponse = createHash('sha256')
    .update(challengeCode)
    .update(VERIFICATION_TOKEN)
    .update(endpoint)
    .digest('hex');

  return NextResponse.json({ challengeResponse }, { status: 200 });
}

/**
 * The notification itself.
 *
 * This application stores no personal data belonging to eBay users. It holds
 * the seller's own catalogue — SKUs, quantities and listing identifiers — and
 * never buyer names, addresses or contact details, so a deletion request has
 * nothing to erase. The notification is acknowledged and recorded so the
 * request is auditable, and nothing else happens.
 *
 * Because the handler takes no action, the `x-ebay-signature` header is
 * recorded but not cryptographically verified: a spoofed notification could
 * not cause anything to be deleted. If this app ever begins storing eBay user
 * data, that verification becomes necessary before acting on a notification —
 * it needs eBay's public key from the Notification API and an ECDSA check.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const data = body?.notification?.data ?? {};
    console.info('[ebay] account deletion notification', {
      notificationId: body?.notification?.notificationId ?? null,
      userId: data.userId ?? null,
      signaturePresent: !!request.headers.get('x-ebay-signature'),
      storedDataToErase: 'none — no eBay user personal data is held',
    });
  } catch (e) {
    // Acknowledge regardless: eBay retries on non-2xx, and a parse failure on
    // our side is not a reason to make it keep trying.
    console.error('[ebay] deletion notification could not be parsed:', e);
  }

  return new NextResponse(null, { status: 200 });
}
