import type { Metadata } from "next";
import { getProducts } from "@/services";
import { PageHeader, DashboardCard, DataTable, Money, StatusBadge } from "@/components/ui";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage() {
  const products = await getProducts();
  return (
    <div className="stack">
      <PageHeader eyebrow="Catalogue" title="Products" subtitle="The product library that feeds your Brand Brain, content and Amazon listings." />
      <DashboardCard flush>
        <DataTable
          rows={products}
          empty={{ title: "No products yet", hint: "Add your first piece to start generating content." }}
          columns={[
            { header: "Product", primary: true, cell: (p) => <>{p.name}<small>{p.sku}</small></> },
            { header: "Category", cell: (p) => p.category },
            { header: "Price", cell: (p) => <Money value={p.price} /> },
            { header: "Stock", cell: (p) => <span className="num">{p.stock}</span> },
            { header: "Channels", cell: (p) => p.channels.map((c) => <span className="tag" key={c}>{c}</span>) },
            { header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
          ]}
        />
      </DashboardCard>
    </div>
  );
}
