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

## Environment

| Variable | Notes |
|---|---|
| `EBAY_CLIENT_ID` | App ID |
| `EBAY_CLIENT_SECRET` | Cert ID |
| `EBAY_DEV_ID` | Dev ID |
| `EBAY_REDIRECT_URI` | the **RuName**, not a URL |
| `EBAY_ENVIRONMENT` | `sandbox` or `production` |

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
