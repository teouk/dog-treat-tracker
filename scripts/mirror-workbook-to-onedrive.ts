/**
 * Mirrors the local master workbook into a OneDrive-synced folder, so it can
 * be watched in Excel during local testing.
 *
 * Why the app does not simply write there itself: `~/Library/CloudStorage/...`
 * is not a plain directory on macOS, it is a virtual filesystem intercepted by
 * OneDrive's File Provider daemon. A dev server writing straight into it was
 * observed to hang indefinitely and intermittently — one request finished in
 * 650ms, the next never returned at all, with no error, stuck inside a bare
 * fs.writeFile. That risk does not belong on the request path, so the app
 * writes to the fast local `data/` file and this copies it across afterwards.
 *
 * Detection is by polling rather than fs.watch. The workbook writer replaces
 * the file atomically (temp file + rename), which swaps in a new inode;
 * fs.watch binds to the *original* inode and silently stops firing after the
 * first replacement, which is exactly how an earlier version of this script
 * went quietly dead after one successful mirror. Polling a stat() cannot be
 * fooled that way.
 *
 * Usage:
 *   npm run workbook:mirror
 *   npm run workbook:mirror -- --to "/some/other/OneDrive/glorious stok.xlsx"
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_SOURCE = path.join(process.cwd(), 'data', 'glorious stok.xlsx');
const DEFAULT_TARGET =
  '/Users/teo/Library/CloudStorage/OneDrive-SwanseaUniversity/dog-treat-tracker-test/glorious stok.xlsx';

const POLL_MS = 1000;
/** A copy into the cloud folder can stall; abandon and retry rather than wedge. */
const COPY_TIMEOUT_MS = 15_000;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const source = argValue('--from') ?? DEFAULT_SOURCE;
const target = argValue('--to') ?? process.env.WORKBOOK_MIRROR_TARGET ?? DEFAULT_TARGET;

/** Identity of a file version, used to decide whether anything actually changed. */
type Fingerprint = string | null;

async function fingerprint(file: string): Promise<Fingerprint> {
  try {
    const s = await fs.stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

async function copyWithTimeout(from: string, to: string, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`copy timed out after ${ms}ms`)), ms);
  });
  try {
    await Promise.race([fs.copyFile(from, to), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stamp(): string {
  return new Date().toLocaleTimeString('en-GB');
}

async function main() {
  if ((await fingerprint(source)) === null) {
    throw new Error(`Source workbook not found at ${source}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });

  console.log(`Watching:  ${source}`);
  console.log(`Mirror to: ${target}`);
  console.log(`Polling every ${POLL_MS}ms. Ctrl+C to stop.\n`);

  let lastMirrored: Fingerprint = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    const current = await fingerprint(source);
    // A missing source is transient: the writer deletes nothing, but there is a
    // brief moment mid-rename where a stat can miss. Skip and catch it next tick.
    if (current === null || current === lastMirrored) return;

    busy = true;
    try {
      await copyWithTimeout(source, target, COPY_TIMEOUT_MS);
      lastMirrored = current;
      const s = await fs.stat(target);
      console.log(`[${stamp()}] mirrored (${s.size} bytes)`);
    } catch (err) {
      // Leave lastMirrored alone so the next tick retries this same version.
      console.error(`[${stamp()}] mirror FAILED: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  };

  await tick(); // push the current state immediately
  setInterval(tick, POLL_MS);
}

main().catch(err => { console.error(err); process.exit(1); });
