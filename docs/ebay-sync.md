# eBay sync

Pulls eBay listing quantities into `inventory.ebay_quantity`.

Like Shopify, eBay stock is **displayed but never added to a product's
Total**. Both are shop-front figures for units fulfilled out of the same
physical shop stock, so counting either would count the shelf twice.

## Why the Trading API

The Sell Inventory API is SKU-keyed and requires every listing to carry a
custom label. This seller has active listings with no label at all, which
cannot exist in that model, so Inventory would simply not see them. Trading
reads any listing regardless of how it was created.

## The RuName

eBay's OAuth `redirect_uri` is **not a URL** — it is the RuName, an opaque
handle eBay resolves to the callback URL it holds on file. Passing the actual
callback URL is the most common cause of `invalid_request` here, so
`EBAY_REDIRECT_URI` holds the RuName and the real callback
(`/api/ebay/callback`) is configured only in the developer portal.

eBay also refuses `localhost` and requires HTTPS for the accepted URL, so the
callback points at the deployed Vercel domain even during local development.

## Production keysets are disabled until this endpoint exists

eBay disables every production keyset until the Marketplace Account Deletion /
Closure notification process is satisfied, so `/api/ebay/deletion` is a gate on
the integration rather than an optional extra.

Validation is a handshake: eBay GETs the endpoint with a one-off
`challenge_code` and expects the SHA-256 of
`challengeCode + verificationToken + endpoint`, hex encoded, in that order. The
endpoint string must match what is registered character for character — a
trailing slash is enough to produce a valid-looking hash that eBay rejects
without explaining why. `EBAY_DELETION_ENDPOINT` is therefore the single source
of truth rather than deriving it from the request.

The route is deliberately unauthenticated, because eBay calls it with none of
our credentials. That is safe because the POST handler takes no action: this
app stores the seller's own catalogue — SKUs, quantities, listing IDs — and no
personal data belonging to eBay users, so a deletion request has nothing to
erase. It is acknowledged and logged for auditability.

For the same reason the `x-ebay-signature` header is recorded but not
cryptographically verified — a spoofed notification could not cause anything to
be deleted. If this app ever stores eBay user data, that verification must be
added before acting on a notification.

Three places must hold the identical verification token: the eBay portal, the
Vercel environment, and `.env.local`.

## Environment

| Variable | Notes |
|---|---|
| `EBAY_CLIENT_ID` | App ID |
| `EBAY_CLIENT_SECRET` | Cert ID |
| `EBAY_DEV_ID` | Dev ID |
| `EBAY_REDIRECT_URI` | the **RuName**, not a URL |
| `EBAY_ENVIRONMENT` | `sandbox` or `production` |
| `EBAY_VERIFICATION_TOKEN` | 32-80 chars; must match the eBay portal exactly |
| `EBAY_DELETION_ENDPOINT` | the registered deletion URL, hashed during validation |

Sandbox and production have entirely separate keysets and RuNames, and the
sandbox contains none of the seller's real listings — a sandbox sync
legitimately returns zero. Real quantities need production credentials.

Tokens live in the `settings` table: the refresh token lasts around 18 months,
access tokens about two hours and are refreshed automatically with five
minutes of headroom. When the refresh token finally lapses the connect flow
has to be run again.

## Matching, and why suggestions are advisory

eBay custom labels follow their own scheme (`M-YakCheese-3ct`) rather than the
app's (`GLS-15CM-BP1`), and some listings have none. Only an exact,
case-insensitive SKU match is ever written.

Everything else is reported as unmatched with a *suggested* SKU where the
product names overlap enough to be worth checking. Suggestions are never
applied automatically: writing a quantity onto the wrong product is worse than
leaving it unmatched, and name similarity is not evidence enough to move stock.

A suggestion is withheld entirely unless it beats the runner-up by a margin.
Real listings routinely tie — several SKUs of one product differ only by a
pack size the title never mentions — and a tie means the score is not
discriminating, so naming a winner would invite a confident wrong answer.

The intended workflow is to relabel listings in eBay so their custom labels
match the app's SKUs. After that the exact match covers everything and none of
this machinery matters. The unmatched report exists to make that relabelling
tractable rather than a search through 173 SKUs, and it can be done gradually:
each listing starts syncing as soon as its label lines up.

Variation listings are flattened so each variation is its own row, because a
variation carries its own SKU and quantity while the parent reports only their
sum.

## One SKU on several listings

A SKU can legitimately appear on more than one active listing, and eBay treats
each as an independent stock pool it will sell from — two listings of 40 mean
eBay is prepared to ship 80. The quantity is therefore summed, because that is
what eBay will actually sell.

When the same physical stock is listed twice, that sum is an overselling
exposure rather than real availability, so `ebay_listing_count` records how
many listings a SKU came from and the column marks anything above one. The
sync also returns a `duplicates` report with the per-listing quantities and
whether they agree: equal quantities suggest a mirrored listing, unequal ones
mean the two have drifted and at least one is wrong.

Seen on 2026-09-09: 10 of 45 matched SKUs were on two listings each, six of
them with quantities that had drifted apart — one pair read 5 and 49. The
underlying fix is to consolidate the duplicate listings in eBay; until then
the app shows the true exposure rather than hiding it behind the smaller
number.

## Endpoints

```
GET  /api/ebay/install      start the consent flow
GET  /api/ebay/callback     eBay redirects here; validates the state nonce
GET  /api/ebay/status       { configured, connected, environment }
POST /api/ebay/disconnect   forget the stored tokens
GET  /api/sync/ebay         pull quantities; returns matched/unmatched
```

The sync response carries the unmatched list; the UI logs it via `console.table`
since it is a working document rather than something that fits in a toast.

## Verification

```bash
npm run verify:ebay
```

Exercises the tokenizer, the similarity scoring and the suggestion thresholds
against the real inventory table. The eBay side is typed from Seller Hub
because the sandbox has no listings to read.
