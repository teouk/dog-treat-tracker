# Amazon sync

Two separate actions, because they answer different questions at very
different speeds.

| | Endpoint | What it does | Typical time |
|---|---|---|---|
| **Amazon** button | `GET /api/sync` | FBA stock levels only | ~2s |
| **Full** button | `GET /api/sync/amazon` | Listings, ASINs, variation families, inbound shipments | seconds when a report is reused, otherwise minutes |
| Nightly cron | `GET /api/sync` | Same as the Amazon button | ~2s |

## Why the button was slow

The orange button used to run the *comprehensive* sync. Its first stage asks
Amazon to build a `GET_MERCHANT_LISTINGS_ALL_DATA` report, which Amazon queues
its own side and can take several minutes to produce — and stock is stage
three of five, so nothing visible changed until it finished. The browser drove
the whole thing in up to forty round trips, so the tab had to stay open.

`runFastSync` already existed and was wired to nothing but the nightly cron.
It reads FBA quantities directly from the inventory summaries API: 88 SKUs at
50 per request is two calls. That is now what the button does.

## Report reuse

`findRecentReport` looks for a finished listings report before asking for a
new one. The old code requested a fresh report on **every** run, discarding
one built moments earlier.

- Default window: 6 hours (`AMAZON_REPORT_MAX_AGE_MINUTES`)
- The newest eligible report wins; a future-dated one is rejected as clock skew
- A lookup failure returns null, so the sync falls back to building a report
  rather than failing
- **Shift-click the Full button**, or add `?fresh=1`, to force a brand-new
  report when a listing has genuinely just changed

The response reports `reusedReport` and `reportAgeMinutes`, and the progress
line says which happened.

## Request pacing

`RateLimiter` is a token bucket matching how SP-API actually meters requests —
a sustained rate with a burst allowance — replacing a flat `sleep()` after
every call.

The inbound-shipment stage makes one request per shipment. It used to run them
strictly one at a time with a 600ms sleep after each, so thirty shipments cost
about thirty seconds of mostly waiting. They now run four at a time against a
2/sec bucket with a burst of 30, which is what the endpoint documents as
acceptable: the burst is spent immediately and only then does it settle to the
sustained rate.

## Token caching

`getAccessToken()` caches the LWA token for its hour, less a five-minute
safety margin, and de-duplicates concurrent callers so a burst opens one auth
request rather than several. The full sync previously fetched a brand-new
token at the top of every one of its up-to-forty round trips.

Because a cached token could otherwise be reused for the rest of its life
after being revoked, a 401 or 403 from any SP-API call clears it.

## Do you need a bigger Vercel plan?

No. `maxDuration = 60` is the Hobby ceiling and a larger one would not help:
the Full button's remaining wait is Amazon queueing a report on their side, so
a longer function limit just waits longer inside one invocation instead of
several. Report reuse is what removes that wait, and it costs nothing.

## Verification

```bash
npm run verify:amazon
```

Covers token caching (including concurrent callers and failure recovery), the
rate limiter's burst and sustained behaviour, the concurrency helper's limit
and ordering, and every branch of the report-reuse decision. Stubs the network
throughout, so it needs no credentials.
