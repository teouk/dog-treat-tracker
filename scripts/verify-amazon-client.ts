/**
 * Regression tests for the Amazon client: token caching, request pacing, and
 * the decision to reuse a recent listings report.
 *
 *   npm run verify:amazon
 *
 * `axios.post` is replaced before the client is imported, so this never
 * touches the network and needs no credentials. It has to live inside the
 * project: resolving `axios` by any other specifier yields a different module
 * instance, and the stub would silently miss.
 */
import axios from 'axios';

let calls = 0;
let failNext = false;

(axios as unknown as { post: unknown }).post = async () => {
  calls++;
  if (failNext) { failNext = false; throw new Error('simulated auth failure'); }
  return { data: { access_token: `token-${calls}`, expires_in: 3600 } };
};

let failures = 0;
function check(label: string, condition: boolean, detail = '') {
  if (!condition) failures++;
  console.log(`[${condition ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const { getAccessToken, invalidateAccessToken } = await import('../src/lib/amazon');

  const first = await getAccessToken();
  check('first call fetches a token', calls === 1 && first === 'token-1', `calls=${calls}`);

  const second = await getAccessToken();
  check('second call is served from cache', calls === 1 && second === first, `calls=${calls}`);

  // The comprehensive sync used to pay one of these per round trip.
  const before = calls;
  invalidateAccessToken();
  const burst = await Promise.all(Array.from({ length: 10 }, () => getAccessToken()));
  check('10 concurrent callers make exactly 1 request', calls === before + 1,
    `made ${calls - before}`);
  check('all 10 receive the same token', new Set(burst).size === 1,
    [...new Set(burst)].join(', '));

  const afterBurst = await getAccessToken();
  check('still cached after the burst', calls === before + 1 && afterBurst === burst[0]);

  invalidateAccessToken();
  const refreshed = await getAccessToken();
  check('invalidate forces a refetch', calls === before + 2 && refreshed !== burst[0],
    `token=${refreshed}`);

  // A failed refresh must not wedge the cache — the next call has to retry.
  invalidateAccessToken();
  failNext = true;
  let threw = false;
  try { await getAccessToken(); } catch { threw = true; }
  check('an auth failure propagates to the caller', threw);

  const recovered = await getAccessToken();
  check('a later call recovers after a failure',
    typeof recovered === 'string' && recovered.startsWith('token-'), recovered);

  await rateLimiterChecks();
  await concurrencyChecks();
  await reportReuseChecks();

  console.log(failures === 0 ? '\nAMAZON CLIENT OK' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

async function rateLimiterChecks() {
  console.log('\n-- rate limiter --');
  const { RateLimiter } = await import('../src/lib/amazon');

  // The burst allowance must be spendable immediately; the old fixed sleep
  // would have taken 30 x 600ms = 18s to do the same work.
  const burst = new RateLimiter(2, 30);
  let start = Date.now();
  for (let i = 0; i < 30; i++) await burst.acquire();
  const burstMs = Date.now() - start;
  check('30 burst tokens are granted immediately', burstMs < 200, `${burstMs}ms`);

  // Once the bucket is empty it must settle to the sustained rate.
  start = Date.now();
  await burst.acquire();
  const nextMs = Date.now() - start;
  check('the 31st request waits for a refill (~500ms at 2/sec)',
    nextMs >= 400 && nextMs < 1200, `${nextMs}ms`);

  // Concurrent acquirers must not double-spend a token.
  const tight = new RateLimiter(100, 4);
  start = Date.now();
  await Promise.all(Array.from({ length: 8 }, () => tight.acquire()));
  const concurrentMs = Date.now() - start;
  check('8 concurrent acquires on a burst-4 bucket are throttled',
    concurrentMs >= 30, `${concurrentMs}ms for the 4 over budget`);
}

async function concurrencyChecks() {
  console.log('\n-- mapWithConcurrency --');
  const { mapWithConcurrency } = await import('../src/lib/amazon');

  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  const out = await mapWithConcurrency(items, 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });

  check('never exceeds the concurrency limit', peak <= 4, `peak ${peak}`);
  check('actually runs in parallel', peak > 1, `peak ${peak}`);
  check('results keep input order', out.every((v, i) => v === i * 2));
  check('empty input is handled', (await mapWithConcurrency([], 4, async () => 1)).length === 0);

  // One failing item must not abort the rest — inbound shipments rely on this.
  const partial = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    try { if (n === 2) throw new Error('boom'); return n; } catch { return -1; }
  });
  check('a handled failure does not lose the other items',
    JSON.stringify(partial) === '[1,-1,3]', JSON.stringify(partial));
}

async function reportReuseChecks() {
  console.log('\n-- findRecentReport --');
  const amazon = await import('../src/lib/amazon');
  const realFetch = globalThis.fetch;

  const stub = (reports: unknown[], ok = true) => {
    globalThis.fetch = (async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ reports }),
      text: async () => '',
    })) as unknown as typeof fetch;
  };

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const SIX_HOURS = 6 * 60 * 60_000;

  stub([{ reportId: 'r1', reportDocumentId: 'd1', processingEndTime: minutesAgo(30) }]);
  const fresh = await amazon.findRecentReport('tok', 'TYPE', SIX_HOURS);
  check('a 30-minute-old report is reused', fresh?.documentId === 'd1' && fresh?.ageMinutes === 30,
    JSON.stringify(fresh));

  stub([{ reportId: 'r1', reportDocumentId: 'd1', processingEndTime: minutesAgo(600) }]);
  check('a 10-hour-old report is rejected',
    (await amazon.findRecentReport('tok', 'TYPE', SIX_HOURS)) === null);

  stub([
    { reportId: 'old', reportDocumentId: 'dOld', processingEndTime: minutesAgo(300) },
    { reportId: 'new', reportDocumentId: 'dNew', processingEndTime: minutesAgo(10) },
    { reportId: 'mid', reportDocumentId: 'dMid', processingEndTime: minutesAgo(120) },
  ]);
  const newest = await amazon.findRecentReport('tok', 'TYPE', SIX_HOURS);
  check('the newest eligible report wins', newest?.documentId === 'dNew', JSON.stringify(newest));

  stub([{ reportId: 'r1', processingEndTime: minutesAgo(5) }]);
  check('a report with no document id is skipped',
    (await amazon.findRecentReport('tok', 'TYPE', SIX_HOURS)) === null);

  // Clock skew: a report stamped in the future is unusable, not infinitely fresh.
  stub([{ reportId: 'r1', reportDocumentId: 'd1', processingEndTime: minutesAgo(-90) }]);
  check('a future-dated report is rejected (clock skew)',
    (await amazon.findRecentReport('tok', 'TYPE', SIX_HOURS)) === null);

  stub([], false);
  check('a failed lookup returns null rather than throwing',
    (await amazon.findRecentReport('tok', 'TYPE', SIX_HOURS)) === null);

  globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  check('a network error returns null rather than throwing',
    (await amazon.findRecentReport('tok', 'TYPE', SIX_HOURS)) === null);

  globalThis.fetch = realFetch;
}

main().catch(err => { console.error(err); process.exit(1); });
