/* eslint-disable react/prop-types */
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [ruleCount, latestRun, recentLogs, updatedToday, totalSynced] =
    await Promise.all([
      prisma.customizationRule.count({ where: { shop, enabled: true } }),
      prisma.bulkSyncRun.findFirst({
        where: { shop },
        orderBy: { startedAt: "desc" },
      }),
      prisma.syncLog.findMany({
        where: { shop, type: "AUTO", status: "UPDATED" },
        orderBy: { createdAt: "desc" },
        take: 6,
      }),
      prisma.syncLog.count({
        where: {
          shop,
          status: "UPDATED",
          createdAt: { gte: startOfToday() },
        },
      }),
      prisma.syncLog.count({ where: { shop, status: "UPDATED" } }),
    ]);

  return {
    ruleCount,
    updatedToday,
    totalSynced,
    hasRules: ruleCount > 0,
    latestRun: latestRun
      ? {
          status: latestRun.status,
          updated: latestRun.updatedCount,
          total: latestRun.totalProducts,
          startedAt: latestRun.startedAt.toISOString(),
        }
      : null,
    recentLogs: recentLogs.map((l) => ({
      id: l.id,
      status: l.status,
      productTitle: l.productTitle || l.productId || "—",
      newFeedPrice: l.newFeedPrice || "—",
      createdAt: l.createdAt.toISOString(),
    })),
  };
};

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function Index() {
  const {
    ruleCount,
    updatedToday,
    totalSynced,
    hasRules,
    latestRun,
    recentLogs,
  } = useLoaderData();

  return (
    <s-page heading="Dashboard">
      {!hasRules && (
        <s-section>
          <s-banner tone="info" heading="Get started">
            <s-paragraph>
              Add your first customization rule to start syncing feed prices.
              A rule maps a product tag to a fixed amount that&apos;s added to
              the product&apos;s base price.
            </s-paragraph>
            <s-button href="/app/customizations" variant="primary">
              Add a customization rule
            </s-button>
          </s-banner>
        </s-section>
      )}

      <s-section heading="At a glance">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 500px) 1fr, 1fr auto 1fr auto 1fr"
          gap="base"
          alignItems="center"
        >
          <StatTile
            href="/app/customizations"
            label="Active rules"
            value={ruleCount}
          />
          <s-divider direction="block"></s-divider>
          <StatTile
            href="/app/logs"
            label="Updated today"
            value={updatedToday}
          />
          <s-divider direction="block"></s-divider>
          <StatTile
            href="/app/logs"
            label="Total synced"
            value={totalSynced}
          />
        </s-grid>
      </s-section>

      <s-section heading="Quick actions">
        <s-stack direction="inline" gap="base">
          <s-button href="/app/customizations" variant="primary">
            Manage customization pricing
          </s-button>
          <s-button href="/app/bulk-sync" variant="secondary">
            Run bulk update
          </s-button>
          <s-button href="/app/logs" variant="tertiary">
            View logs
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Recent sync activity">
        {recentLogs.length === 0 ? (
          <s-paragraph>
            No activity yet. Feed prices will appear here as products change.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Time</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Feed price</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentLogs.map((log) => (
                <s-table-row key={log.id}>
                  <s-table-cell>
                    {new Date(log.createdAt).toLocaleString()}
                  </s-table-cell>
                  <s-table-cell>{log.productTitle}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={logTone(log.status)}>{log.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{log.newFeedPrice}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="How it works" slot="aside">
        <s-paragraph>
          <s-text type="strong">Feed price = base price + customization.</s-text>{" "}
          The customization amount is matched to a product tag. Prices update
          automatically when a product changes.
        </s-paragraph>
      </s-section>

      <s-section heading="Latest bulk update" slot="aside">
        {latestRun ? (
          <s-stack direction="block" gap="small-200">
            <s-badge tone={latestRun.status === "COMPLETED" ? "success" : "info"}>
              {latestRun.status}
            </s-badge>
            <s-text>
              {latestRun.updated} of {latestRun.total} products updated
            </s-text>
            <s-text color="subdued">
              {new Date(latestRun.startedAt).toLocaleString()}
            </s-text>
            <s-link href="/app/bulk-sync">View bulk updates</s-link>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="small-200">
            <s-paragraph>No bulk update has run yet.</s-paragraph>
            <s-link href="/app/bulk-sync">Run one now</s-link>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

function StatTile({ href, label, value }) {
  return (
    <s-clickable
      href={href}
      paddingBlock="base"
      paddingInline="small-100"
      borderRadius="base"
    >
      <s-grid gap="small-300" justifyItems="center">
        <s-text type="strong" color="subdued">
          {label}
        </s-text>
        <s-heading>{value}</s-heading>
      </s-grid>
    </s-clickable>
  );
}

function logTone(status) {
  if (status === "UPDATED") return "success";
  if (status === "FAILED") return "critical";
  return "neutral";
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
