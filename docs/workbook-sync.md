# Master workbook sync

Pushes Amazon, Shopify and depot stock into `glorious stok.xlsx` and keeps its
money columns consistent, replacing the manual Google Apps Script step.

```
src/lib/workbook/
  turkish.ts         Turkish-aware text folding; Turkish money parse/format
  schema.ts          Column alias map — the only file to edit on a rename
  read.ts            ExcelJS reader -> plain grid
  resolve-layout.ts  Header row discovery, column scoring, total-row location
  xlsx-writer.ts     Surgical cell patcher (the write path)
  store.ts           Storage seam: LocalFileStore today, Graph tomorrow
  stock-sync.ts      Value calculation and orchestration
  auto-sync.ts       Non-fatal hook called after any stock change
```

## What the workbook actually contains

Reverse-engineered from the real file rather than assumed:

| | |
|---|---|
| Sheet | `Sheet1`, used range `A1:S113` |
| Headers | Row 1 |
| Product rows | 2–112 (111 rows) |
| Grand total | Row 113 — label `TOPLAM` in `I113`, value in `J113` |
| Stock columns | `F` `Depot_OnHand`, `G` `Shopify_Qty`, `H` `Amazon_Qty_UK` — stored as numbers |
| Money columns | `I` `Paket_Fiyatı`, `J` `Toplam_Stok_Fiyatı` — stored as **text** |
| Columns `L`–`S` | An unrelated accounting block. Never touched. |

Two properties drive most of the design:

**There are no formulas anywhere.** Every value is a literal, so nothing
recalculates itself. If the sync did not write `J` and `J113`, they would
silently drift out of line with the stock beside them.

**Money is text, not numbers.** The cells hold strings like `£ 12.308,22`,
in the Turkish convention where `.` groups thousands and `,` is the decimal
point, and zero is written `£ -`. Writing real numbers instead would change
every visible amount in the sheet, so the writer reproduces the existing
format exactly — and reads the currency wording out of the file rather than
hard-coding `£`, so a switch to `₺` needs no code change.

## The value formula

```
Toplam_Stok_Fiyatı  =  (Depot_OnHand + Amazon_Qty_UK) × Paket_Fiyatı
TOPLAM (J113)       =  Σ of the above
```

This was derived from the file and **verified against all 111 product rows
with zero mismatches**, and the recomputed grand total matches the stated
`£ 35.537,72` exactly. `Shopify_Qty` is deliberately excluded: it is a
shop-front figure fulfilled out of the depot, so counting it would count the
same stock twice.

`fbm_quantity` is excluded from the Amazon column for the same reason —
merchant-fulfilled orders ship from the depot and are already in `shop_stock`.

| Workbook column | Database column |
|---|---|
| `Depot_OnHand` | `inventory.shop_stock` |
| `Shopify_Qty` | `inventory.shopify_quantity` |
| `Amazon_Qty_UK` | `inventory.fba_quantity` |

The depot-only value (`Σ Depot_OnHand × Paket_Fiyatı`, currently
`£ 29.817,12`) is reported on every sync as `totals.depotInventoryValue`. It
is **not** written to the sheet, which has no column for it — adding one would
change the owner's layout.

## Turkish header mapping

`schema.ts` holds an alias list per logical column, written in normalised
form. Matching runs in tiers, strongest evidence first:

| Tier | Score | Meaning |
|---|---|---|
| `exact` | 1.00 | normalised header is an alias verbatim |
| `tokens` | ~0.90 | every alias word present, e.g. `Amazon Qty UK (FBA)` |
| `substring` | ~0.80 | alias appears inside the header |
| `fuzzy` | <0.80 | edit distance, accepted only above `FUZZY_MIN_SCORE` **and** only if it beats the runner-up by `FUZZY_MIN_MARGIN` |

Every (column, field) pair is scored, then consumed in descending order, so
the strongest evidence wins globally and neither a column nor a field is
assigned twice. `Amazon_Qty_UK` therefore claims `amazonQty` before the
weaker bare `amazon` alias can.

Fuzzy matching is kept deliberately strict because `Shopify_Qty` and
`Amazon_Qty_UK` are textually similar, and silently swapping two stock
columns would corrupt the master sheet in a way nobody would notice for
weeks. **A required column that cannot be resolved throws**, listing the
headers actually found — the sync never guesses.

### The Turkish casing trap

```js
'TOPLAM STOK FİYATI'.toLowerCase()   // "toplam stok fi̇yati"  ← i + U+0307
```

`İ` lowercases to an ASCII `i` followed by a COMBINING DOT ABOVE, which never
compares equal to the `fiyati` in a config file. Dotless `ı` has the mirror
problem. `foldTurkish()` maps both cases of `İ ı ğ ü ş ö ç` explicitly
*before* any case operation, so this cannot bite.

The header row is discovered by scoring the first 10 rows, not assumed to be
row 1, so a title banner added above the table does not break the sync.

### When the owner renames a column

Add the new wording to the relevant `aliases` array in `schema.ts`. Nothing
else needs to change. `GET /api/workbook/sync` shows the resolved mapping.

## Why the writer is not ExcelJS

ExcelJS reads this file correctly and is used for exactly that. Its **writer**
is not used, because re-serialising the workbook from its object model is
measurably lossy on this file. Round-tripping the real master through
`workbook.xlsx.writeFile`:

- rewrote the theme font `Aptos Narrow` → **`Calibri`**, across every cell
- **dropped** `xl/printerSettings/printerSettings1.bin` and its relationship
- dropped `bestFit` from all 15 column widths, and `tabSelected` from the sheet view

`xlsx-writer.ts` instead treats the `.xlsx` as the zip of XML parts it is,
rewrites only the specific `<c>` elements being changed, and copies every
other entry through untouched. The guarantee is structural rather than a
promise: a part that is not the target worksheet cannot change, because
nothing ever rewrites it.

Two further protections:

- **Formulas are never overwritten.** A target cell containing `<f>` is
  skipped and reported. If the owner converts `J` to real formulas, the sync
  stops writing that column and Excel recalculates it instead — the correct
  outcome, not merely the safe one.
- **The `s=` style index of every edited cell is preserved**, so number
  formats, fonts and fills survive an edit.

Cells that do not exist yet (the workbook omits blanks) are created in correct
column order, with `spans` and `<dimension>` widened to match.

## Safety behaviours

| Situation | Behaviour |
|---|---|
| SKU on two workbook rows | The row already carrying stock is synced; the empty twin is left completely untouched. Both cases in the file resolve cleanly — `GLS-BITES-BP51` to row 11, `GLS-15CM-CSB344` to row 50. |
| Duplicate where none or several rows carry stock | All left untouched and reported — nothing identifies the live row, and guessing would move stock between products |
| Row with no SKU (row 96) | Skipped entirely: no quantities written, no value recomputed. Its existing value still counts toward TOPLAM. |
| Sheet SKU not in the database | Quantities kept; line total still recomputed |
| Database SKU not in the sheet | Reported as `skusNotInWorkbook` |
| Required column unresolvable | Throws, listing the headers found |
| Grand-total row absent | Row totals still written; a warning is returned |
| Every write | Timestamped backup first, then a temp-file-plus-rename |

Skipped rows are reported per row number in `skippedRows`, and always keep
whatever their value cell already says. TOPLAM must equal the literal sum of
the column beneath it — a skipped row that was silently dropped from the total
would make the sheet contradict itself.

## Which columns get written

`WORKBOOK_SYNC_COLUMNS` controls this. All three stock columns are on by
default — but that is only safe because the app now holds real depot figures.

`Depot_OnHand` is the owner's physical count, and it lived **only** in the
workbook until the depot import below was run. A live check on 2026-09-04
found 2 of 142 SKUs with any depot stock in the database, 20 units in total,
all of it left over from test receipts — against ~60 populated rows worth
`£ 29.817,12` in the sheet. Enabling that column before the import would not
have updated the sheet, it would have erased it.

```
WORKBOOK_SYNC_COLUMNS=depot,shopify,amazon  # default
WORKBOOK_SYNC_COLUMNS=all                   # same thing
WORKBOOK_SYNC_COLUMNS=shopify,amazon        # kill switch, if the two diverge again
```

Every run reports `syncedColumns`, and a run with depot disabled says so in
`warnings`, so this can never be silently forgotten.

### Seeding depot stock from the workbook

```bash
npm run workbook:import-depot            # report only
npm run workbook:import-depot -- --apply # write to the database
```

Copies `Depot_OnHand` into `inventory.shop_stock`, using the same duplicate
and no-SKU rules as the sync so both directions agree about which row
represents a product. Every change is recorded in `stock_adjustments` with
`source = 'workbook-import'`, so it appears in the app's history like any
other stock movement and can be traced or reversed per SKU.

Run on 2026-09-04: 77 of 108 usable sheet rows matched an inventory row, 47
were updated, and depot units went from 20 to 10,753. Re-running it now
reports `0 would update` — the two sides agree, which is also why a workbook
sync no longer proposes a single depot change.

### Products in the sheet but not in the app

```bash
npm run workbook:import-missing            # report only
npm run workbook:import-missing -- --apply # create the inventory rows
```

Creates an `inventory` row per unmatched workbook product, taking
`variant_label` from the sheet's `Bag` column and setting the channel flags
from the sheet's own record — a row with an FNSKU is an Amazon product, a row
with Shopify stock is a Shopify product. Both syncs only ever write SKUs their
API returns, so a discontinued listing costs one slot in a request batch and
can never be zeroed by a sync that does not know about it.

Run on 2026-09-04: 31 products created, 188 depot units brought in, and the
workbook sync's "in sheet, not in database" count went from 31 to 0.

Historical note — before that run, **31 sheet SKUs had no inventory row** —
7 of those carry real depot stock (188 units: `GLS-FS-LT18`, `GLS-Y-26`,
`GLS-Y-19`, `GLS-FS-LSB55`, `GLS-FS-LLF62`, `GLS-Y-07`, `GLS-Y-16`). Those
rows are simply never touched by the sync, so the sheet keeps its own figures
for them. Adding the products to the app is what would bring them under
management.

## Storage seam

Everything above `WorkbookStore` deals in bytes and knows nothing about where
the file lives, so moving to OneDrive means adding one implementation and
flipping `WORKBOOK_DRIVER`.

```ts
interface WorkbookStore {
  read(): Promise<Buffer>;
  write(data: Buffer, meta: WriteMeta): Promise<void>;
  describe(): string;
}
```

`GraphWorkbookStore` is stubbed with the endpoints it will need. Two things
will differ from the local store:

- **Concurrency.** Graph has no rename-into-place. Capture the item's `eTag`
  on read and send it as `If-Match` on write, so the sync fails loudly if
  someone edited the workbook in Excel Online meanwhile.
- **Cost.** Each sync becomes two transfers of the whole document, so
  per-adjustment auto-sync should be debounced or queued before it is enabled
  there. `WORKBOOK_AUTO_SYNC` therefore defaults to off for the Graph driver.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WORKBOOK_DRIVER` | `local` | `local` or `graph` |
| `WORKBOOK_PATH` | `data/glorious stok.xlsx` | Local file location |
| `WORKBOOK_BACKUP_DIR` | `data/backups` | Pre-write backups |
| `WORKBOOK_KEEP_BACKUPS` | `20` | Backups retained |
| `WORKBOOK_AUTO_SYNC` | on for `local` | Sync after every stock change |
| `WORKBOOK_SYNC_COLUMNS` | `shopify,amazon` | Stock columns the sync may write |

## API

```
GET  /api/workbook/sync    dry run: resolved mapping, pending changes, both totals
POST /api/workbook/sync    apply  (body { "dryRun": true } also runs a dry run)
```

Both accept the cron bearer token or a signed-in session, matching
`/api/sync`. A missing workbook returns `503 WORKBOOK_UNAVAILABLE`.

The sync also runs automatically after every stock movement — manual
adjustment, pallet receipt, Amazon fast/comprehensive sync, Shopify sync —
and each of those responses carries a `workbook` field with the outcome. A
workbook failure never fails the stock change: the database is the system of
record and has already committed by then.

## Verification

```bash
npm run verify:workbook       # offline, against a scratch copy of the real file
npm run workbook:dry-run      # against the real database, writes nothing
npm run workbook:dry-run -- --apply
```

`workbook:dry-run` reads `DATABASE_URL` from `.env.local` and prints the
resolved mapping, SKU match counts, skipped rows, every changed row with
before→after values, and both totals. It is the only check that exercises
`loadInventory()` and the SKU matching between `inventory.sku` and the sheet's
`Item` column.

Copies the real file to a scratch directory and asserts, end to end: Turkish
folding and money formatting; column mapping against the real headers; the
value formula against all 111 rows; that a dry run writes nothing; correct
values after a live write, including cells created from nothing; that
**no zip part is added, lost, or changed except the worksheet and the shared
string table**; that `styles.xml`, `theme1.xml` and `workbook.xml` stay
byte-identical and the font is still `Aptos Narrow`; that the accounting block
and the identity/price columns are unchanged; that a strict parser reopens the
result; that a second run is a no-op; and that a backup of the untouched
original was taken.
