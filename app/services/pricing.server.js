import prisma from "../db.server";

/**
 * Feed price = variant base price + customization amount.
 *
 * The customization amount is resolved by matching the product's tags against
 * the CustomizationRule table (tag -> fixed amount). If more than one rule
 * matches, the FIRST matching rule (in the order the product lists its tags)
 * wins.
 *
 * The result is written to the product-level `custom.feed_price` metafield
 * (type: number_decimal — a plain decimal string like "30.00").
 */

export const FEED_METAFIELD = {
  namespace: "custom",
  key: "feed_price",
  type: "number_decimal",
};

/**
 * Load all enabled customization rules for a shop into a Map<tag, amount>.
 * Tags are compared case-insensitively.
 */
export async function loadRuleMap(shop) {
  const rules = await prisma.customizationRule.findMany({
    where: { shop, enabled: true },
  });
  const map = new Map();
  for (const rule of rules) {
    map.set(rule.tag.trim().toLowerCase(), Number(rule.amount));
  }
  return map;
}

/**
 * Given a product's tags and a rule map, find the first matching tag/amount.
 * Returns { tag, amount } or null when no tag matches.
 */
export function matchCustomization(tags, ruleMap) {
  for (const tag of tags) {
    const key = String(tag).trim().toLowerCase();
    if (ruleMap.has(key)) {
      return { tag, amount: ruleMap.get(key) };
    }
  }
  return null;
}

const PRODUCT_QUERY = `#graphql
  query feedPriceProduct($id: ID!) {
    product(id: $id) {
      id
      title
      tags
      feedPrice: metafield(namespace: "custom", key: "feed_price") { value }
      variants(first: 1) {
        edges { node { id price } }
      }
    }
  }`;

/**
 * Fetch the minimal product data needed to compute a feed price.
 */
export async function fetchProduct(admin, productId) {
  const res = await admin.graphql(PRODUCT_QUERY, {
    variables: { id: productId },
  });
  const json = await res.json();
  return json?.data?.product || null;
}

/**
 * Compute the feed price for a product-shaped object.
 * `product` must have { title, tags: string[], variants }.
 *
 * Returns:
 *   { status: "SKIPPED", reason } when no tag matches or no base price,
 *   { status: "UPDATED", basePrice, amount, feedPrice, matchedTag } otherwise.
 */
export function computeFeedPrice(product, ruleMap) {
  const firstVariant = product?.variants?.edges?.[0]?.node;
  const basePriceRaw = firstVariant?.price;

  if (basePriceRaw == null || basePriceRaw === "") {
    return { status: "SKIPPED", reason: "No base price on product" };
  }

  const match = matchCustomization(product.tags || [], ruleMap);
  if (!match) {
    return { status: "SKIPPED", reason: "No matching customization tag" };
  }

  const basePrice = Number(basePriceRaw);
  const amount = Number(match.amount);
  if (!Number.isFinite(basePrice) || !Number.isFinite(amount)) {
    return {
      status: "SKIPPED",
      reason: "Base price or customization amount is not a valid number",
      matchedTag: match.tag,
    };
  }
  const feedPrice = (basePrice + amount).toFixed(2);

  // Avoid rewriting (and re-triggering the products/update webhook) when the
  // stored feed price already matches the freshly computed one. Compare
  // numerically on both sides so "30", "30.0", "30.00" all count as equal.
  const currentNum = Number(parseFeedMetafield(product.feedPrice?.value));
  if (Number.isFinite(currentNum) && currentNum.toFixed(2) === feedPrice) {
    return {
      status: "SKIPPED",
      reason: "Feed price already up to date",
      matchedTag: match.tag,
    };
  }

  return {
    status: "UPDATED",
    basePrice: basePrice.toFixed(2),
    amount: amount.toFixed(2),
    feedPrice,
    matchedTag: match.tag,
  };
}

/**
 * Extract the numeric amount from a number_decimal metafield value.
 * The value is a plain decimal string like "110.00". We also tolerate the
 * legacy money-shaped JSON value ({"amount":"110.00",...}) so any product
 * written before the type switch still compares correctly.
 */
export function parseFeedMetafield(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed)?.amount ?? null;
    } catch {
      return null;
    }
  }
  return trimmed;
}

/**
 * Write the feed price to the product's custom.feed_price money metafield.
 * Throws on GraphQL/user errors so callers can log a FAILED result.
 */
export async function writeFeedMetafield(admin, productId, feedPrice) {
  const res = await admin.graphql(
    `#graphql
    mutation feedPriceSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: FEED_METAFIELD.namespace,
            key: FEED_METAFIELD.key,
            type: FEED_METAFIELD.type,
            // number_decimal expects a plain decimal string, e.g. "30.00"
            value: feedPrice,
          },
        ],
      },
    },
  );
  const json = await res.json();
  const errors = json?.data?.metafieldsSet?.userErrors;
  if (errors && errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

/**
 * Full auto-sync for a single product: fetch (if needed), compute, write, log.
 *
 * `input` may be either a productId (string/gid) or a pre-fetched product
 * object. `ruleMap` is an optional cache for bulk callers.
 *
 * Returns the SyncLog row that was written.
 */
export async function syncProduct(admin, shop, input, opts = {}) {
  const type = opts.type || "AUTO";
  const bulkRunId = opts.bulkRunId || null;

  let product = typeof input === "string" ? null : input;
  const productId = typeof input === "string" ? input : input?.id;

  try {
    const ruleMap = opts.ruleMap || (await loadRuleMap(shop));

    if (!product) {
      product = await fetchProduct(admin, productId);
    }
    if (!product) {
      return logResult(shop, {
        type,
        bulkRunId,
        productId,
        status: "FAILED",
        message: "Product not found",
      });
    }

    const result = computeFeedPrice(product, ruleMap);

    // For auto-sync, don't log the no-op "already up to date" case — it would
    // flood the log on every product save. Bulk runs still record it.
    if (
      result.status === "SKIPPED" &&
      result.reason === "Feed price already up to date" &&
      type === "AUTO"
    ) {
      return null;
    }

    if (result.status === "SKIPPED") {
      return logResult(shop, {
        type,
        bulkRunId,
        productId: product.id,
        productTitle: product.title,
        status: "SKIPPED",
        message: result.reason,
      });
    }

    await writeFeedMetafield(admin, product.id, result.feedPrice);

    return logResult(shop, {
      type,
      bulkRunId,
      productId: product.id,
      productTitle: product.title,
      status: "UPDATED",
      matchedTag: result.matchedTag,
      basePrice: result.basePrice,
      newFeedPrice: result.feedPrice,
      message: `${result.basePrice} + ${result.amount} (${result.matchedTag}) = ${result.feedPrice}`,
    });
  } catch (err) {
    return logResult(shop, {
      type,
      bulkRunId,
      productId: product?.id || productId,
      productTitle: product?.title,
      status: "FAILED",
      message: err?.message || String(err),
    });
  }
}

/**
 * Persist a SyncLog row and return it.
 */
export async function logResult(shop, data) {
  return prisma.syncLog.create({
    data: {
      shop,
      type: data.type,
      status: data.status,
      productId: data.productId || null,
      productTitle: data.productTitle || null,
      matchedTag: data.matchedTag || null,
      basePrice: data.basePrice || null,
      newFeedPrice: data.newFeedPrice || null,
      message: data.message || null,
      bulkRunId: data.bulkRunId || null,
    },
  });
}
