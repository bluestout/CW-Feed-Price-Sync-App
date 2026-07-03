/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PAGE_SIZE = 100;
const STATUSES = ["ALL", "UPDATED", "SKIPPED", "FAILED"];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const rawStatus = (url.searchParams.get("status") || "UPDATED").toUpperCase();
  const status = STATUSES.includes(rawStatus) ? rawStatus : "UPDATED";
  const search = (url.searchParams.get("q") || "").trim();
  const date = url.searchParams.get("date") || ""; // YYYY-MM-DD

  const where = { shop, type: "AUTO" };
  if (status !== "ALL") where.status = status;
  if (search) {
    where.productTitle = { contains: search, mode: "insensitive" };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // Interpret the picked day in UTC (Railway runs UTC and createdAt is stored
    // in UTC) so the day window is stable regardless of server locale.
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    if (!Number.isNaN(start.getTime())) {
      where.createdAt = { gte: start, lt: end };
    }
  }

  const logs = await prisma.syncLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
  });

  return {
    status,
    search,
    date,
    logs: logs.map((l) => ({
      id: l.id,
      status: l.status,
      productTitle: l.productTitle || l.productId || "—",
      matchedTag: l.matchedTag || "—",
      basePrice: l.basePrice || "—",
      newFeedPrice: l.newFeedPrice || "—",
      message: l.message || "",
      createdAt: l.createdAt.toISOString(),
    })),
  };
};

export default function LogsPage() {
  const { status, search, date, logs } = useLoaderData();
  const [, setSearchParams] = useSearchParams();

  // Merge a partial change into the current params, dropping empty values.
  // Uses the functional updater so it always builds from the LATEST params —
  // this avoids a stale-closure race where a debounced search write could
  // clobber a status/date change made a moment earlier.
  const update = (patch) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  };

  // Local, immediately-editable search box; the URL param updates after a pause
  // so we don't refetch on every keystroke.
  const [searchInput, setSearchInput] = useState(search);
  const didMount = useRef(false);

  // Keep the box in sync if the URL changes elsewhere (e.g. Clear filters).
  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    const t = setTimeout(() => {
      if (searchInput !== search) update({ q: searchInput });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const hasFilters = status !== "UPDATED" || search || date;

  return (
    <s-page heading="Sync logs">
      {/* Top row: Filters (wide) + About (narrow), side by side */}
      <s-grid
        gridTemplateColumns="@container (inline-size <= 800px) 1fr, 2fr 1fr"
        gap="base"
        paddingBlockEnd="base"
      >
        <s-section heading="Filters">
          <s-stack direction="block" gap="base">
            {/* Status filter chips */}
            <s-stack direction="block" gap="small-200">
              <s-text type="strong" color="subdued">
                Status
              </s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                {STATUSES.map((s) => (
                  <s-clickable-chip
                    key={s}
                    color={status === s ? "strong" : "subdued"}
                    accessibilityLabel={`Show ${s.toLowerCase()} logs`}
                    onClick={() => update({ status: s })}
                  >
                    {chipLabel(s)}
                  </s-clickable-chip>
                ))}
              </s-stack>
            </s-stack>

            {/* Search + date filters */}
            <s-grid
              gridTemplateColumns="@container (inline-size <= 500px) 1fr, 2fr 1fr"
              gap="base"
              alignItems="end"
            >
              <s-search-field
                label="Search by product"
                placeholder="Product title…"
                value={searchInput}
                onInput={(e) => setSearchInput(e.target.value)}
              />
              <s-date-field
                label="Date"
                value={date}
                onChange={(e) => update({ date: e.target.value })}
              />
            </s-grid>

            {hasFilters && (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text color="subdued">
                  Showing {chipLabel(status).toLowerCase()} logs
                  {search ? ` matching “${search}”` : ""}
                  {date ? ` on ${date}` : ""}.
                </s-text>
                <s-button
                  variant="tertiary"
                  onClick={() => setSearchParams(new URLSearchParams())}
                >
                  Clear filters
                </s-button>
              </s-stack>
            )}
          </s-stack>
        </s-section>

        <s-section heading="About these logs">
          <s-paragraph>
            Each time a product&apos;s base price or tags change, its feed price
            is recalculated automatically. Showing the most recent {PAGE_SIZE}{" "}
            matching events.
          </s-paragraph>
          <s-paragraph>
            For full bulk-run results, download the CSV from the{" "}
            <s-link href="/app/bulk-sync">Bulk Update</s-link> page.
          </s-paragraph>
        </s-section>
      </s-grid>

      {/* Full-width results table */}
      <s-section heading={`Results (${logs.length})`}>
        {logs.length === 0 ? (
          <s-paragraph>
            No matching sync events. Try adjusting the filters above.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Time</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Tag</s-table-header>
              <s-table-header>Base</s-table-header>
              <s-table-header>Feed price</s-table-header>
              <s-table-header>Details</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {logs.map((log) => (
                <s-table-row key={log.id}>
                  <s-table-cell>{formatTime(log.createdAt)}</s-table-cell>
                  <s-table-cell>{log.productTitle}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(log.status)}>{log.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{log.matchedTag}</s-table-cell>
                  <s-table-cell>{log.basePrice}</s-table-cell>
                  <s-table-cell>{log.newFeedPrice}</s-table-cell>
                  <s-table-cell>
                    {log.status === "UPDATED" ? "—" : log.message}
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

function chipLabel(status) {
  if (status === "ALL") return "All";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusTone(status) {
  if (status === "UPDATED") return "success";
  if (status === "FAILED") return "critical";
  return "neutral";
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
