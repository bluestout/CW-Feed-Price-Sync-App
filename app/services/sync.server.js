import prisma from "../db.server";
import {
  loadRuleMap,
  computeFeedPrice,
  writeFeedMetafield,
} from "./pricing.server";

/**
 * Bulk feed-price sync engine.
 *
 * Walks the entire product catalog with cursor pagination (250/page), computes
 * the feed price for each product, writes the metafield, and records the
 * outcome. A BulkSyncRun row tracks the summary and holds a downloadable CSV.
 *
 * Sized for ~1250 products: ~5 pages, sequential metafield writes to stay well
 * under Shopify's GraphQL cost limits. Runs in the background (not awaited by
 * the request) and updates the BulkSyncRun row as it progresses.
 */

const PRODUCTS_PAGE = `#graphql
  query bulkFeedPriceProducts($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          tags
          feedPrice: metafield(namespace: "custom", key: "feed_price") { value }
          variants(first: 1) {
            edges { node { id price } }
          }
        }
      }
    }
  }`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one page of products, retrying on throttling / transient failures with
 * exponential backoff. Throws if the page still can't be read after retries so
 * the caller can fail the run instead of silently truncating the catalog.
 */
async function fetchProductsPage(admin, cursor, attempt = 0) {
  const MAX_ATTEMPTS = 4;
  let json;
  try {
    const res = await admin.graphql(PRODUCTS_PAGE, { variables: { cursor } });
    json = await res.json();
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(1000 * 2 ** attempt);
      return fetchProductsPage(admin, cursor, attempt + 1);
    }
    throw new Error(`Failed to fetch products page: ${err?.message || err}`);
  }

  const page = json?.data?.products;
  if (page) return page;

  // No data — likely THROTTLED or a transient error. Back off and retry.
  if (attempt < MAX_ATTEMPTS) {
    await sleep(1000 * 2 ** attempt);
    return fetchProductsPage(admin, cursor, attempt + 1);
  }

  const reason = json?.errors
    ? JSON.stringify(json.errors)
    : "empty products response";
  throw new Error(`Could not read products page after retries: ${reason}`);
}

/**
 * Start a bulk run. Creates the BulkSyncRun row immediately and returns it;
 * the actual processing runs in the background via runBulkSync().
 */
export async function startBulkSync(admin, shop) {
  const run = await prisma.bulkSyncRun.create({
    data: { shop, status: "RUNNING" },
  });

  // Fire-and-forget: keep the request fast, update the row as we go.
  runBulkSync(admin, shop, run.id).catch(async (err) => {
    await prisma.bulkSyncRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        message: err?.message || String(err),
        finishedAt: new Date(),
      },
    });
  });

  return run;
}

/**
 * Process every product for a bulk run. Safe to call directly (awaited) in
 * tests. Updates counts on the BulkSyncRun row and builds the CSV at the end.
 */
export async function runBulkSync(admin, shop, runId) {
  const ruleMap = await loadRuleMap(shop);

  const rows = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let total = 0;
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    // Fetch a page, retrying on throttling / transient null responses. If a
    // page can't be fetched after retries we throw, so the run is marked FAILED
    // rather than silently reported COMPLETE with a truncated catalog.
    const page = await fetchProductsPage(admin, cursor);

    for (const edge of page.edges) {
      const product = edge.node;
      total += 1;
      const result = computeFeedPrice(product, ruleMap);

      let status = result.status;
      let message = "";
      let matchedTag = "";
      let basePrice = "";
      let newFeedPrice = "";

      if (result.status === "UPDATED") {
        try {
          await writeFeedMetafield(admin, product.id, result.feedPrice);
          updated += 1;
          matchedTag = result.matchedTag;
          basePrice = result.basePrice;
          newFeedPrice = result.feedPrice;
          message = `${result.basePrice} + ${result.amount} (${result.matchedTag}) = ${result.feedPrice}`;
        } catch (err) {
          status = "FAILED";
          failed += 1;
          message = err?.message || String(err);
        }
      } else {
        skipped += 1;
        message = result.reason;
      }

      rows.push({
        productId: product.id,
        productTitle: product.title,
        status,
        matchedTag,
        basePrice,
        newFeedPrice,
        message,
      });
    }

    hasNext = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;

    // Periodic progress update so the UI can show live counts.
    await prisma.bulkSyncRun.update({
      where: { id: runId },
      data: { totalProducts: total, updatedCount: updated, skippedCount: skipped, failedCount: failed },
    });
  }

  const csvData = buildCsv(rows);

  await prisma.bulkSyncRun.update({
    where: { id: runId },
    data: {
      status: "COMPLETED",
      totalProducts: total,
      updatedCount: updated,
      skippedCount: skipped,
      failedCount: failed,
      csvData,
      finishedAt: new Date(),
      message: `${updated} updated, ${skipped} skipped, ${failed} failed of ${total}`,
    },
  });

  return { total, updated, skipped, failed };
}

/**
 * Build a CSV string from bulk result rows.
 */
export function buildCsv(rows) {
  const header = [
    "Product ID",
    "Product Title",
    "Status",
    "Matched Tag",
    "Base Price",
    "New Feed Price",
    "Message",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.productId,
        r.productTitle,
        r.status,
        r.matchedTag,
        r.basePrice,
        r.newFeedPrice,
        r.message,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
