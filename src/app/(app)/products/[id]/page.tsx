import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLiveOrg } from "@/lib/auth/access";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { getProduct } from "@/services";
import { ProductForm } from "@/components/product-form";
import { PageHeader, DashboardCard, Money, SectionHeader, StatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Product" };

/** Product detail and edit. Live organisations only: the demo catalogue has no detail page. */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isLiveOrg())) notFound();
  const p = await getProduct(id);
  if (!p) notFound();
  const canWrite = can((await getAuthUser())?.role, "products:write");
  return (
    <div className="stack">
      <PageHeader eyebrow={p.category || "Catalogue"} title={p.name} subtitle={p.sku} actions={<StatusBadge status={p.status} />} />
      <div className="grid even">
        <DashboardCard>
          <SectionHeader title="Details" />
          <dl style={{ margin: 0 }}>
            <dt className="muted">Price</dt><dd>{p.price === null ? "Not set" : <Money value={p.price} />}</dd>
            <dt className="muted">Stock</dt><dd>{p.stock ?? "Not set"}</dd>
            <dt className="muted">Channels</dt><dd>{p.channels.length ? p.channels.map((c) => <span className="tag" key={c}>{c}</span>) : "None"}</dd>
          </dl>
        </DashboardCard>
        {canWrite && (
          <DashboardCard>
            <SectionHeader title="Edit product" />
            <ProductForm productId={p.id} initial={{
              sku: p.sku, name: p.name, category: p.category, price: p.price === null ? "" : String(p.price), stock: p.stock === null ? "" : String(p.stock),
              status: p.status, channels: p.channels.join(", "),
            }} />
          </DashboardCard>
        )}
      </div>
    </div>
  );
}
