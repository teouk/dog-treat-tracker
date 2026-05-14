import crypto from 'node:crypto';
import { getDb } from '@/lib/db';

let migrationRan = false;

/**
 * Idempotent migration for security-related tables.
 *   - login_attempts: rate-limit failed credentials sign-ins
 *   - The shopify_oauth_state row lives in the existing `settings` table
 */
export async function ensureSecurityColumns(): Promise<void> {
  if (migrationRan) return;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      email TEXT NOT NULL,
      attempt_at TIMESTAMPTZ DEFAULT NOW(),
      success BOOLEAN NOT NULL DEFAULT FALSE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email, attempt_at)`;
  migrationRan = true;
}

/**
 * Cryptographically secure random hex string for OAuth state nonces.
 */
export function secureNonce(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Verify Shopify OAuth callback HMAC. Shopify signs all callback query
 * parameters (except `hmac` itself) with the app's client secret. We
 * reconstruct the canonical message and compare in constant time.
 */
export function verifyShopifyHmac(query: URLSearchParams, clientSecret: string): boolean {
  const hmac = query.get('hmac');
  if (!hmac) return false;

  const entries: string[] = [];
  for (const [k, v] of query.entries()) {
    if (k === 'hmac') continue;
    entries.push(`${k}=${v}`);
  }
  entries.sort();
  const message = entries.join('&');

  const calculated = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(hmac, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Store an OAuth state nonce with a 10-minute expiry. Returns the nonce.
 */
export async function storeOAuthState(scope: string): Promise<string> {
  const sql = getDb();
  const nonce = secureNonce();
  const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const value = JSON.stringify({ nonce, expires: expiry });
  await sql`
    INSERT INTO settings (key, value) VALUES (${`oauth_state_${scope}`}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
  return nonce;
}

/**
 * Verify and one-shot consume an OAuth state nonce. Returns true if it
 * matches AND is unexpired. Deletes the row after a successful check so
 * the nonce can't be replayed.
 */
export async function consumeOAuthState(scope: string, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const sql = getDb();
  const rows = await sql`SELECT value FROM settings WHERE key = ${`oauth_state_${scope}`}` as Array<{ value: string }>;
  if (rows.length === 0) return false;
  let parsed: { nonce: string; expires: string };
  try { parsed = JSON.parse(rows[0].value); } catch { return false; }
  if (new Date(parsed.expires).getTime() < Date.now()) return false;
  if (parsed.nonce !== candidate) return false;
  await sql`DELETE FROM settings WHERE key = ${`oauth_state_${scope}`}`;
  return true;
}

/**
 * Returns true if the email has too many recent failed login attempts.
 * Threshold: 10 failed attempts within the last 15 minutes.
 */
export async function isLoginRateLimited(email: string): Promise<boolean> {
  if (!email) return false;
  await ensureSecurityColumns();
  const sql = getDb();
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const rows = await sql`
    SELECT COUNT(*)::int AS cnt FROM login_attempts
    WHERE email = ${email} AND success = FALSE AND attempt_at > ${since}
  ` as Array<{ cnt: number }>;
  return (rows[0]?.cnt || 0) >= 10;
}

export async function recordLoginAttempt(email: string, success: boolean): Promise<void> {
  if (!email) return;
  try {
    await ensureSecurityColumns();
    const sql = getDb();
    await sql`INSERT INTO login_attempts (email, success) VALUES (${email}, ${success})`;
    if (success) {
      // Clear any failed-attempt history on successful login
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await sql`DELETE FROM login_attempts WHERE email = ${email} AND success = FALSE AND attempt_at > ${since}`;
    }
  } catch {
    // Never block a login because logging failed
  }
}

/**
 * Constant-time string compare. Use for credentials checks.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  } catch {
    return false;
  }
}
