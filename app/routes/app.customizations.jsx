/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const rules = await prisma.customizationRule.findMany({
    where: { shop: session.shop },
    orderBy: { tag: "asc" },
  });
  return {
    rules: rules.map((r) => ({
      id: r.id,
      tag: r.tag,
      amount: Number(r.amount).toFixed(2),
      enabled: r.enabled,
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "delete") {
    const id = String(form.get("id"));
    await prisma.customizationRule.deleteMany({ where: { id, shop } });
    return { ok: true, toast: "Rule deleted" };
  }

  if (intent === "toggle") {
    const id = String(form.get("id"));
    const enabled = form.get("enabled") === "true";
    await prisma.customizationRule.updateMany({
      where: { id, shop },
      data: { enabled },
    });
    return { ok: true };
  }

  // create / update
  const id = form.get("id") ? String(form.get("id")) : null;
  const tag = String(form.get("tag") || "").trim();
  const amountRaw = String(form.get("amount") || "").trim();
  const amount = Number(amountRaw);

  if (!tag) {
    return { ok: false, error: "Tag is required" };
  }
  // Reject empty, NaN, negative, and non-finite (Infinity/1e400) values, plus
  // anything too large for the Decimal(12,2) column.
  if (
    !amountRaw ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > 9_999_999_999
  ) {
    return { ok: false, error: "Amount must be a valid number ≥ 0" };
  }

  try {
    if (id) {
      // Scope by shop so one shop can never overwrite another shop's rule.
      // updateMany returns a count and does not throw when nothing matches.
      const { count } = await prisma.customizationRule.updateMany({
        where: { id, shop },
        data: { tag, amount },
      });
      if (count === 0) {
        return { ok: false, error: "Rule not found" };
      }
    } else {
      await prisma.customizationRule.create({
        data: { shop, tag, amount },
      });
    }
  } catch (err) {
    if (err?.code === "P2002") {
      return { ok: false, error: `A rule for tag "${tag}" already exists` };
    }
    throw err;
  }

  return { ok: true, toast: id ? "Rule updated" : "Rule added" };
};

export default function CustomizationsPage() {
  const { rules } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const formRef = useRef(null);

  const saving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save";

  useEffect(() => {
    if (fetcher.data?.toast) {
      shopify.toast.show(fetcher.data.toast);
      formRef.current?.reset();
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Customization pricing">
      <s-section heading="Add a customization rule">
        <s-paragraph>
          Map a product <s-text>tag</s-text> to a fixed customization amount.
          When a product carries a matching tag, its feed price becomes{" "}
          <s-text>base price + this amount</s-text>. If a product has several
          matching tags, the first one listed on the product wins.
        </s-paragraph>
        <fetcher.Form method="post" ref={formRef}>
          <input type="hidden" name="intent" value="save" />
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field
              name="tag"
              label="Product tag"
              placeholder="e.g. engraving"
            />
            <s-number-field
              name="amount"
              label="Customization amount"
              step={0.01}
              min={0}
              placeholder="10.00"
            />
            <s-button
              variant="primary"
              type="submit"
              {...(saving ? { loading: true } : {})}
            >
              Add rule
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading={`Rules (${rules.length})`}>
        {rules.length === 0 ? (
          <s-paragraph>No rules yet. Add your first rule above.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Tag</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rules.map((rule) => (
                <RuleRow key={rule.id} rule={rule} />
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

function RuleRow({ rule }) {
  const fetcher = useFetcher();
  return (
    <s-table-row>
      <s-table-cell>{rule.tag}</s-table-cell>
      <s-table-cell>{rule.amount}</s-table-cell>
      <s-table-cell>
        <s-badge tone={rule.enabled ? "success" : "neutral"}>
          {rule.enabled ? "Enabled" : "Disabled"}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-200">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="toggle" />
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="enabled" value={(!rule.enabled).toString()} />
            <s-button variant="tertiary" type="submit">
              {rule.enabled ? "Disable" : "Enable"}
            </s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="id" value={rule.id} />
            <s-button variant="tertiary" tone="critical" type="submit">
              Delete
            </s-button>
          </fetcher.Form>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
