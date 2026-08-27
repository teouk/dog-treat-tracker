import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb } from '@/lib/db';
import { ensureSchema } from '@/lib/migrate';

/**
 * PATCH — rename a group, or clear the override to fall back to the
 * auto-derived name.
 *   { group_key: string, display_name: string | null }
 */
export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  const body = await request.json().catch(() => ({}));
  const groupKey = typeof body.group_key === 'string' ? body.group_key.trim() : '';
  if (!groupKey) return NextResponse.json({ error: 'group_key required' }, { status: 400 });

  const sql = getDb();

  if (body.display_name === null || body.display_name === '') {
    await sql`DELETE FROM product_groups WHERE group_key = ${groupKey}`;
    return NextResponse.json({ success: true, display_name: null });
  }

  const name = String(body.display_name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'display_name required' }, { status: 400 });
  if (name.length > 120) return NextResponse.json({ error: 'display_name too long' }, { status: 400 });

  await sql`
    INSERT INTO product_groups (group_key, display_name)
    VALUES (${groupKey}, ${name})
    ON CONFLICT (group_key) DO UPDATE SET display_name = EXCLUDED.display_name
  `;
  return NextResponse.json({ success: true, display_name: name });
}

/**
 * POST — manually move SKUs into a group, or release them back to their
 * automatic grouping.
 *   { skus: string[], group_key: string | null }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureSchema();
  const body = await request.json().catch(() => ({}));
  const skus: string[] = Array.isArray(body.skus)
    ? body.skus.filter((s: unknown): s is string => typeof s === 'string' && !!s.trim())
    : [];
  if (skus.length === 0) return NextResponse.json({ error: 'skus required' }, { status: 400 });

  const sql = getDb();

  if (body.group_key === null) {
    await sql`UPDATE inventory SET group_override = NULL WHERE sku = ANY(${skus})`;
    return NextResponse.json({ success: true, moved: skus.length, group_key: null });
  }

  const groupKey = String(body.group_key ?? '').trim();
  if (!groupKey) return NextResponse.json({ error: 'group_key required' }, { status: 400 });

  await sql`
    INSERT INTO product_groups (group_key) VALUES (${groupKey})
    ON CONFLICT (group_key) DO NOTHING
  `;
  await sql`UPDATE inventory SET group_override = ${groupKey} WHERE sku = ANY(${skus})`;

  return NextResponse.json({ success: true, moved: skus.length, group_key: groupKey });
}
