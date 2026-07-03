# Feed Price Sync

An embedded Shopify app that keeps a product's **feed price** metafield in sync
with its base price plus a customization amount.

> **Feed price = variant base price + customization amount**
> The customization amount is resolved by matching the product's tags against
> customization rules you define in the app (tag → fixed amount). If a product
> has multiple matching tags, the **first matching tag** wins. The result is
> written to the product-level `custom.feed_price` metafield
> (type: `number_decimal`).

This replaces the earlier serverless function + metaobject setup and the manual
Matrixify import/export workflow.

## Features

1. **Customization pricing** (`/app/customizations`) — Define customization
   prices as `tag → amount` rules. No metaobjects required; rules live in the
   app database.
2. **Bulk sync** (`/app/bulk-sync`) — Recalculate `custom.feed_price` for the
   entire catalog after you change a customization amount. Each run produces a
   downloadable **CSV log** of every product's result.
3. **Auto-sync** (webhooks) — When a product is created or its base price / tags
   change (`products/create`, `products/update`), its feed price is recomputed
   automatically. Each product update produces a **per-product log**.
4. **Logs** (`/app/logs`) — Browse auto-sync events (filter by status). Bulk run
   history and CSV downloads live on the Bulk sync page.

### Loop prevention

Writing the metafield fires `products/update` again. The auto-sync handler
re-fetches the product, compares the freshly computed feed price against the
stored one, and skips the write (without logging) when they already match — so
it never loops.

## Tech stack

- React Router 7 + Polaris web components (`s-*`)
- `@shopify/shopify-app-react-router`
- Prisma ORM → **PostgreSQL**
- Deployed on **Railway** (Docker)

## Data model (Prisma)

- `Session` — Shopify session storage.
- `CustomizationRule` — `shop`, `tag`, `amount`, `enabled` (unique per shop+tag).
- `SyncLog` — one row per product per sync event (auto or bulk).
- `BulkSyncRun` — summary + CSV text of each bulk run.

## Local development

```shell
# 1. Install deps
npm install

# 2. Provide a Postgres connection string
echo 'DATABASE_URL="postgresql://user:pass@localhost:5432/feed_price_sync"' > .env

# 3. Apply schema
npm run setup   # prisma generate && prisma migrate deploy

# 4. Run the app (Shopify CLI provides the tunnel + app URL/keys)
npm run dev
```

## Deploying to Railway

1. **Create a Postgres database** in your Railway project. Railway exposes its
   connection string as `DATABASE_URL`.

2. **Create a service from this repo.** Railway builds the included
   `Dockerfile`. On boot it runs `npm run docker-start`, which runs
   `prisma generate && prisma migrate deploy` and then starts the server.

3. **Set environment variables** on the service:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | From the Railway Postgres plugin |
   | `SHOPIFY_API_KEY` | From your app in the Partner Dashboard |
   | `SHOPIFY_API_SECRET` | From your app in the Partner Dashboard |
   | `SHOPIFY_APP_URL` | Your Railway public URL, e.g. `https://feed-price-sync.up.railway.app` |
   | `SCOPES` | `read_products,write_products` |

4. **Point the app at Railway.** In `shopify.app.toml`, set `application_url`
   and the `auth.redirect_urls` to your Railway URL, then deploy the app config:

   ```shell
   npm run deploy
   ```

   This also registers the webhook subscriptions
   (`products/create`, `products/update`, `app/uninstalled`, `app/scopes_update`).

The initial Postgres migration is committed under `prisma/migrations/0_init`, so
`prisma migrate deploy` (run automatically on boot) creates the tables on first
deploy. No manual migration step is needed.

## First run

1. Open the app → **Customization pricing** and add your `tag → amount` rules.
2. Go to **Bulk sync** and click **Run bulk sync** to populate every product's
   feed price. Download the CSV to verify results.
3. From then on, feed prices update automatically as products change; watch them
   under **Logs**.
