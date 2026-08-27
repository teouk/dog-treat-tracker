# Outbound stock deductions

When stock leaves the office for a sales channel's warehouse it is still
owned by the business, but it is no longer on the shelf. These deductions
keep `shop_stock` honest by removing those units as soon as the channel
confirms it has them in transit.

## Amazon — on by default

Source: FBA inbound shipments (`/fba/inbound/v0/shipments`), statuses
`WORKING`, `SHIPPED` and `RECEIVING`.

Each shipment line is recorded in `outbound_shipments` keyed by
`(channel, external_id, sku)`, where `external_id` is Amazon's shipment id.
The insert uses `ON CONFLICT DO NOTHING` and every other clause in the
statement is gated on that insert having produced a row, so re-running the
sync deducts nothing the second time. This is safe to run as often as you
like.

An FBA inbound shipment is an unambiguous signal — the pallet has physically
gone to Amazon — which is why this is enabled by default.

## Shopify — off by default

Source: `incoming` quantities from the GraphQL Admin API
(`inventoryItems { inventoryLevels { quantities(names: ["incoming"]) } }`).
The REST endpoint does not expose incoming stock.

Shopify reports a running total per SKU rather than discrete shipments, so
there is no id to key on. Instead `channel_incoming_state` holds a per-SKU
watermark and only the **increase** since the last observation is deducted.
A total that stays flat deducts nothing; a total that falls as stock is
received also deducts nothing.

This is **off by default** on purpose. A Shopify location is often the same
physical shelf as "shop stock" — for a merchant-fulfilled store, Shopify
inventory *is* the office inventory. Deducting in that setup would
double-count the same units and steadily drive shop stock to zero.

Turn it on only if Shopify stock physically lives somewhere other than the
office — for example Shopify Fulfilment Network, or a third-party warehouse
you transfer stock into.

## Toggling

Both are stored in `settings` under `deduct_outbound_amazon` and
`deduct_outbound_shopify`, and exposed at `GET`/`PATCH /api/settings`. The
Amazon toggle is on the Inventory page footer.

## Auditing

Every deduction writes a `stock_adjustments` row with `source = 'outbound'`
and a reason naming the shipment, so it appears in History → All movements
alongside manual changes and deliveries. A deduction that could not be
applied in full — because shop stock was already lower than the shipped
quantity — is clamped at zero and the applied amount is what gets logged,
not the requested amount.
