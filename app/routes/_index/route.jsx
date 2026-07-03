import { redirect } from "react-router";

/**
 * This app has no public landing page — it lives entirely inside the Shopify
 * admin. Any hit to the root URL is sent straight to the embedded app, keeping
 * the shop/host params so App Bridge can authenticate.
 */
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const params = url.searchParams.toString();
  throw redirect(params ? `/app?${params}` : "/app");
};
