import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const run = await prisma.bulkSyncRun.findFirst({
    where: { id: params.id, shop: session.shop },
  });

  if (!run || !run.csvData) {
    throw new Response("Not found", { status: 404 });
  }

  const filename = `feed-price-sync-${run.id}.csv`;
  return new Response(run.csvData, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
