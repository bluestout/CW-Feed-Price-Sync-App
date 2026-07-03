/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { startBulkSync } from "../services/sync.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [ruleCount, runs] = await Promise.all([
    prisma.customizationRule.count({ where: { shop, enabled: true } }),
    prisma.bulkSyncRun.findMany({
      where: { shop },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
  ]);

  const latest = runs[0] || null;

  return {
    ruleCount,
    isRunning: latest?.status === "RUNNING",
    runs: runs.map(serializeRun),
  };
};

function serializeRun(r) {
  return {
    id: r.id,
    status: r.status,
    total: r.totalProducts,
    updated: r.updatedCount,
    skipped: r.skippedCount,
    failed: r.failedCount,
    message: r.message || "",
    hasCsv: !!r.csvData,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  };
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const running = await prisma.bulkSyncRun.findFirst({
    where: { shop, status: "RUNNING" },
  });
  if (running) {
    return { ok: false, error: "A bulk sync is already running" };
  }

  const ruleCount = await prisma.customizationRule.count({
    where: { shop, enabled: true },
  });
  if (ruleCount === 0) {
    return {
      ok: false,
      error: "Add at least one customization rule before running a bulk sync",
    };
  }

  await startBulkSync(admin, shop);
  return { ok: true, toast: "Bulk sync started" };
};

export default function BulkSyncPage() {
  const { ruleCount, isRunning, runs } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const starting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.toast) shopify.toast.show(fetcher.data.toast);
    if (fetcher.data?.error)
      shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  // Poll for progress while a run is active. `revalidator` gets a new identity
  // on every render, so we call it through a ref and depend only on isRunning —
  // this keeps a single stable 3s interval instead of tearing it down and
  // recreating it on every revalidation (which caused a revalidate storm).
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => revalidateRef.current(), 3000);
    return () => clearInterval(t);
  }, [isRunning]);

  return (
    <s-page heading="Bulk Update">
      <s-section heading="Run a full catalog sync">
        <s-paragraph>
          Recalculate the <s-text>custom.feed_price</s-text> metafield for every
          product using the latest customization rules. Use this after you change
          a customization amount. {ruleCount} active rule
          {ruleCount === 1 ? "" : "s"} will be applied.
        </s-paragraph>
        <fetcher.Form method="post">
          <s-button
            variant="primary"
            type="submit"
            {...(starting || isRunning ? { loading: true } : {})}
            {...(isRunning ? { disabled: true } : {})}
          >
            {isRunning ? "Update in progress…" : "Run bulk update"}
          </s-button>
        </fetcher.Form>
      </s-section>

      <s-section heading="Recent runs">
        {runs.length === 0 ? (
          <s-paragraph>No bulk syncs have run yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Started</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Updated</s-table-header>
              <s-table-header>Skipped</s-table-header>
              <s-table-header>Failed</s-table-header>
              <s-table-header>Total</s-table-header>
              <s-table-header>CSV</s-table-header>
            </s-table-header-row>
            <s-table-body>
            {runs.map((run) => (
              <s-table-row key={run.id}>
                <s-table-cell>
                  {new Date(run.startedAt).toLocaleString()}
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone={statusTone(run.status)}>{run.status}</s-badge>
                </s-table-cell>
                <s-table-cell>{run.updated}</s-table-cell>
                <s-table-cell>{run.skipped}</s-table-cell>
                <s-table-cell>{run.failed}</s-table-cell>
                <s-table-cell>{run.total}</s-table-cell>
                <s-table-cell>
                  {run.hasCsv ? (
                    <DownloadButton runId={run.id} />
                  ) : (
                    "—"
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

// Downloading via a plain link opens the CSV inside the embedded admin iframe
// instead of saving a file. Instead we fetch it (App Bridge attaches the
// session token to same-origin requests), build a blob, and trigger a save.
function DownloadButton({ runId }) {
  const shopify = useAppBridge();
  const [loading, setLoading] = useState(false);

  const download = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/app/bulk-sync/download/${runId}`);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `feed-price-sync-${runId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      shopify.toast.show(err.message || "Download failed", { isError: true });
    } finally {
      setLoading(false);
    }
  };

  return (
    <s-button
      variant="tertiary"
      onClick={download}
      {...(loading ? { loading: true } : {})}
    >
      Download
    </s-button>
  );
}

function statusTone(status) {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "critical";
  return "info";
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
