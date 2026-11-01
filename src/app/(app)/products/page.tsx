import Link from "next/link";
import type { Metadata } from "next";
import { isLiveOrg } from "@/lib/auth/access";
import { can } from "@/lib/auth/roles";
import { getAuthUser } from "@/lib/auth/session";
import { getProducts } from "@/services";
import { ProductForm } from "@/components/product-form";
import { PageHeader, DashboardCard, DataTable, Money, SectionHeader, StatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage() {
  const live = await isLiveOrg();
  const canWrite = live && can((await getAuthUser())?.role, "products:write");
  const products = await getProducts();
  return (
    <div className="stack">
      <PageHeader eyebrow="Catalogue" title="Products" subtitle="The product library that feeds your Brand Brain, content and Amazon listings." />
      {canWrite && <DashboardCard><SectionHeader title="Add a product" /><ProductForm /></DashboardCard>}
      <DashboardCard flush>
        <DataTable
          rows={products}
          empty={{ title: "No products yet", hint: canWrite ? "Add your first product above to start generating content." : "Products added by your team will appear here." }}
          columns={[
            { header: "Product", primary: true, cell: (p) => <>{live ? <Link href={`/products/${p.id}`}>{p.name}</Link> : p.name}<small>{p.sku}</small></> },
            { header: "Category", cell: (p) => p.category || "—" },
            { header: "Price", cell: (p) => (p.price === null ? "—" : <Money value={p.price} />) },
            { header: "Stock", cell: (p) => <span className="num">{p.stock ?? "—"}</span> },
            { header: "Channels", cell: (p) => p.channels.map((c) => <span className="tag" key={c}>{c}</span>) },
            { header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
          ]}
        />
      </DashboardCard>
    </div>
  );
}
