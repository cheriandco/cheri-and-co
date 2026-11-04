/** M2: the forms, the import panel and the order table render what a person needs (server-rendered markup; no browser). */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { RecordForm, fieldProblem } from "@/components/record-form";
import { ImportPanel } from "@/components/import-panel";
import { OrderTable } from "@/components/order-table";
import { CUSTOMER_FIELDS, RETAILER_FIELDS, TASK_FIELDS, orderFields, PICK_LIMIT } from "@/lib/forms";
import { IMPORT_COLUMNS, templateCsv } from "@/lib/import";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("M2 forms", () => {
  it("every field has a label tied to its input, and required fields are marked", () => {
    for (const fields of [CUSTOMER_FIELDS, RETAILER_FIELDS, TASK_FIELDS]) {
      const out = html(createElement(RecordForm, { id: "f", fields, endpoint: "/x", method: "POST", submitLabel: "Save", savedText: "ok", invalidHint: "bad" }));
      for (const f of fields) {
        expect(out).toContain(`for="f-${f.name}"`);
        expect(out).toContain(`id="f-${f.name}"`);
      }
      expect(out).toMatch(/Name \*|Business name \*|Task \*/);
      expect(out).toContain(">Save<");
    }
  });
  it("an edit form starts with the saved values", () => {
    const out = html(createElement(RecordForm, { id: "e", fields: CUSTOMER_FIELDS, endpoint: "/api/customers/1", method: "PATCH", submitLabel: "Save changes", savedText: "ok", invalidHint: "bad", initial: { name: "Meera", city: "Pune" } }));
    expect(out).toContain('value="Meera"');
    expect(out).toContain('value="Pune"');
  });
  it("the order form lists customers and retailers, with a blank first choice, and caps a very long list", () => {
    const customers = Array.from({ length: PICK_LIMIT + 50 }, (_, i) => ({ id: `c${i}`, name: `Customer ${i}`, email: i === 0 ? "first@example.com" : "" }));
    const fields = orderFields(customers, [{ id: "r1", business: "Aurelia", location: "Pune" }]);
    const customer = fields.find((f) => f.name === "customerId")!;
    expect(customer.options![0]).toEqual(["", "None"]);
    expect(customer.options).toHaveLength(PICK_LIMIT + 1);
    expect(customer.options![1]).toEqual(["c0", "Customer 0 (first@example.com)"]);
    expect(fields.find((f) => f.name === "retailerId")!.options![1]).toEqual(["r1", "Aurelia, Pune"]);
    expect(fields.find((f) => f.name === "channel")!.options!.map((o) => o[0])).toEqual(["instagram", "amazon", "flipkart", "b2b", "other"]);
    expect(fields.find((f) => f.name === "total")).toMatchObject({ required: true, numeric: true });
  });
});

describe("M2 form checks (before anything is sent)", () => {
  it("requires the required fields and numbers of 0 or more", () => {
    expect(fieldProblem(CUSTOMER_FIELDS, { name: " " })).toBe("Name is required.");
    expect(fieldProblem(CUSTOMER_FIELDS, { name: "Asha" })).toBeNull();
    const fields = orderFields([], []);
    expect(fieldProblem(fields, { total: "" })).toBe("Total (₹) is required.");
    expect(fieldProblem(fields, { total: "-5" })).toMatch(/number, 0 or more/);
    expect(fieldProblem(fields, { total: "abc" })).toMatch(/number, 0 or more/);
    expect(fieldProblem(fields, { total: "1499.50" })).toBeNull();
  });
  it("accepts only YYYY-MM-DD dates (and the task words), so 04/11/2026 or 2026-02-31 are never guessed at", () => {
    const orders = orderFields([], []);
    for (const bad of ["04/11/2026", "2026-02-31", "2026-13-45", "tomorrow", "11-04-2026"]) expect(fieldProblem(orders, { total: "1", orderedAt: bad }), bad).toMatch(/YYYY-MM-DD/);
    expect(fieldProblem(orders, { total: "1", orderedAt: "2026-11-04" })).toBeNull();
    expect(fieldProblem(orders, { total: "1", orderedAt: "" })).toBeNull();
    for (const ok of ["Today", "tomorrow", "This week", "2026-12-01", ""]) expect(fieldProblem(TASK_FIELDS, { title: "x", due: ok }), ok).toBeNull();
    expect(fieldProblem(TASK_FIELDS, { title: "x", due: "next friday" })).toMatch(/YYYY-MM-DD, or today, tomorrow, this week, unscheduled/);
  });
});

describe("M2 import panel", () => {
  it("offers the template download, a file chooser, and documents every column", () => {
    for (const r of ["customers", "retailers", "tasks", "orders"] as const) {
      const out = html(createElement(ImportPanel, { resource: r, noun: r, template: templateCsv(r), columns: IMPORT_COLUMNS[r] }));
      expect(out).toContain("Download template");
      expect(out).toContain("Choose CSV file");
      expect(out).toContain("nothing is saved until you confirm");
      for (const c of IMPORT_COLUMNS[r]) expect(out).toContain(`<code>${c.name}</code>`);
      expect(out).not.toContain("Import 0");
    }
  });
});

describe("M2 order table", () => {
  const rows = [{ id: "o1", date: "2026-11-04", who: "Meera", channel: "instagram", total: "₹1,499", status: "paid" as const }];
  it("a writer gets a status control with every status; a viewer sees plain text", () => {
    const writer = html(createElement(OrderTable, { rows, canWrite: true }));
    expect(writer).toContain("<select");
    for (const s of ["new", "paid", "shipped", "delivered", "cancelled", "returned"]) expect(writer).toContain(`>${s}</option>`);
    const viewer = html(createElement(OrderTable, { rows, canWrite: false }));
    expect(viewer).not.toContain("<select");
    expect(viewer).toContain("paid");
  });
  it("says so when there are no orders", () => {
    expect(html(createElement(OrderTable, { rows: [], canWrite: true }))).toContain("No orders yet");
  });
});
