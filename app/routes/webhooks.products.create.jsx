import { authenticate } from "../shopify.server";
import { syncProduct } from "../services/pricing.server";

/**
 * products/create — compute the feed price for a newly created product so its
 * custom.feed_price metafield is populated from the start.
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
