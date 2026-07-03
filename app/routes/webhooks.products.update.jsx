import { authenticate } from "../shopify.server";
import { syncProduct } from "../services/pricing.server";

/**
 * products/update — recalculate the feed price whenever a product's base price
 * or tags change. We re-fetch the product (rather than trusting the payload) so
 * we always see the current variant price, tags, and existing feed metafield —
 * which also lets us skip no-op writes and avoid re-triggering ourselves.
 */
export const action = async ({ request }) => {
  const { shop, admin, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}`);

  if (!admin || !payload?.id) {
    return new Response();
  }

  const productId = `gid://shopify/Product/${payload.id}`;
  await syncProduct(admin, shop, productId, { type: "AUTO" });

  return new Response();
};
