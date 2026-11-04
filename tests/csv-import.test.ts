/** M2: the CSV reader and the import checker. Pure functions, no database. */
import { describe, expect, it } from "vitest";
import { CsvError, parseCsv, toCsv } from "@/lib/csv";
import { analyseImport, EMPTY_CONTEXT, IMPORT_COLUMNS, IMPORT_RESOURCES, MAX_IMPORT_ROWS, templateCsv, type ImportContext } from "@/lib/import";

describe("parseCsv", () => {
  it("reads plain rows with LF, CRLF and CR endings, and a byte-order mark", () => {
    const expected = [["a", "b"], ["1", "2"]];
    expect(parseCsv("a,b\n1,2")).toEqual(expected);
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual(expected);
    expect(parseCsv("a,b\r1,2")).toEqual(expected);
    expect(parseCsv("﻿a,b\n1,2\n")).toEqual(expected);
  });
  it("reads quoted cells: commas, doubled quotes and line breaks inside quotes", () => {
    expect(parseCsv('name,note\n"Doe, Jane","said ""hi"""\n"two\nlines",x')).toEqual([["name", "note"], ["Doe, Jane", 'said "hi"'], ["two\nlines", "x"]]);
  });
  it("keeps empty cells and blank lines so line numbers stay right", () => {
    expect(parseCsv("a,b,c\n,,\n\nx,,z")).toEqual([["a", "b", "c"], ["", "", ""], [""], ["x", "", "z"]]);
  });
  it("refuses a quote that is never closed", () => {
    expect(() => parseCsv('a,b\n"oops,1')).toThrow(CsvError);
  });
  it("round-trips through toCsv", () => {
    const rows = [["a", 'b,"c"'], ["line\nbreak", ""]];
    expect(parseCsv(toCsv(rows))).toEqual([...rows]);
  });
});

describe("templates", () => {
  it("every resource has a template whose header is exactly its columns, and whose example row is accepted", () => {
    expect(IMPORT_RESOURCES).toEqual(["customers", "retailers", "tasks", "orders"]);
    for (const r of IMPORT_RESOURCES) {
      const table = parseCsv(templateCsv(r));
      expect(table[0], r).toEqual(IMPORT_COLUMNS[r].map((c) => c.name));
      expect(table).toHaveLength(2);
      // the order example names a customer and a retailer that must exist, so give it both
      const ctx: ImportContext = r === "orders" ? { ...EMPTY_CONTEXT, customers: [{ id: "00000000-0000-4000-8000-000000000001", name: "E", email: "example@example.com", phone: "", instagram: "", city: "" }] } : EMPTY_CONTEXT;
      const a = analyseImport(r, templateCsv(r), ctx);
      expect(a.report.headerErrors, r).toEqual([]);
      expect(a.report.counts, r).toMatchObject({ total: 1, valid: 1, invalid: 0 });
    }
  });
});

const CUSTOMERS = "name,email,phone,instagram,city,interests\n";
const status = (csv: string, resource: Parameters<typeof analyseImport>[0], ctx?: ImportContext) => analyseImport(resource, csv, ctx).report.rows.map((r) => r.status);

describe("customers", () => {
  it("accepts good rows and reports the line number of each bad one", () => {
    const a = analyseImport("customers", `${CUSTOMERS}Asha,asha@example.com,+91 98765 43210,@asha,Pune,earrings; necklaces\n,x@y.com,,,,\nBad,not-an-email,,,,\nShort,,123,,,\n`);
    expect(a.report.rows.map((r) => [r.line, r.status])).toEqual([[2, "valid"], [3, "invalid"], [4, "invalid"], [5, "invalid"]]);
    expect(a.report.rows[1].errors).toEqual(["Name is required."]);
    expect(a.report.rows[2].errors).toEqual(["Email address is not valid."]);
    expect(a.report.rows[3].errors).toEqual(["Phone number should have 6 to 15 digits."]);
    expect(a.valid[0].parsed).toMatchObject({ resource: "customers", input: { name: "Asha", email: "asha@example.com", interests: ["earrings", "necklaces"] } });
  });
  it("matches header names loosely (case, spaces, dashes) and ignores unknown columns with a warning", () => {
    const a = analyseImport("customers", "Name , E-Mail,Notes\nAsha,a@b.com,hello\n");
    expect(a.report.headerErrors).toEqual([]);
    expect(a.report.warnings.join(" ")).toMatch(/Ignored columns.*e_mail.*notes/);
    expect(a.report.counts.valid).toBe(1);
  });
  it("rejects a file without the required column, with a repeated column, or with no rows, instead of guessing", () => {
    expect(analyseImport("customers", "email\na@b.com").report.headerErrors).toEqual(["Required column “name” is missing."]);
    expect(analyseImport("customers", "name,name\na,b").report.headerErrors.join(" ")).toMatch(/more than once/);
    expect(analyseImport("customers", "name\n").report.headerErrors.join(" ")).toMatch(/no rows/);
    expect(analyseImport("customers", "").report.headerErrors.join(" ")).toMatch(/empty/);
    expect(analyseImport("customers", "name\n\"open").report.headerErrors.join(" ")).toMatch(/never closed/);
  });
  it("flags duplicates by email, phone digits, instagram handle, or name+city when nothing else is given — against the file and against what exists", () => {
    const ctx: ImportContext = { ...EMPTY_CONTEXT, customers: [{ id: "c1", name: "Meera", email: "Meera@Example.com", phone: "", instagram: "", city: "" }, { id: "c2", name: "Ravi", email: "", phone: "+91 90000 11111", instagram: "@ravi", city: "" }] };
    const csv = `${CUSTOMERS}Meera Again,meera@example.com,,,,\nRavi P,,090000 11111,,,\nRavi Q,,,RAVI,,\nNew One,new@example.com,,,,\nNew One Again,NEW@example.com,,,,\nNo Contact,,,,Goa,\nno contact,,,,GOA,\nNo Contact,,,,Pune,\n`;
    const a = analyseImport("customers", csv, ctx);
    expect(a.report.rows.map((r) => r.status)).toEqual(["duplicate", "duplicate", "duplicate", "valid", "duplicate", "valid", "duplicate", "valid"]);
    expect(a.report.rows[0].note).toMatch(/existing customer/);
    expect(a.report.rows[4].note).toMatch(/line 5 of this file/);
    expect(a.report.counts).toEqual({ total: 8, valid: 3, invalid: 0, duplicate: 5 });
  });
  it("keeps spreadsheet formulas as plain text and never executes or strips them", () => {
    const a = analyseImport("customers", `${CUSTOMERS}=HYPERLINK("http://x"),,,,,\n`);
    expect(a.valid[0].parsed).toMatchObject({ input: { name: '=HYPERLINK("http://x")' } });
  });
  it("refuses over-long values and too many interests", () => {
    expect(status(`${CUSTOMERS}${"x".repeat(201)},,,,,\n`, "customers")).toEqual(["invalid"]);
    expect(status(`${CUSTOMERS}A,,,,,${Array.from({ length: 21 }, (_, i) => `i${i}`).join(";")}\n`, "customers")).toEqual(["invalid"]);
  });
  it("accepts up to the row limit and refuses more, whole", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `Person ${i},p${i}@example.com,,,,`).join("\n");
    expect(analyseImport("customers", `${CUSTOMERS}${rows(MAX_IMPORT_ROWS)}`).report.counts.valid).toBe(MAX_IMPORT_ROWS);
    const over = analyseImport("customers", `${CUSTOMERS}${rows(MAX_IMPORT_ROWS + 1)}`);
    expect(over.report.headerErrors.join(" ")).toMatch(/limit is 200/);
    expect(over.valid).toEqual([]);
  });
});

describe("retailers", () => {
  const H = "business,location,category,contact,email,phone,instagram,website,qualification\n";
  it("requires a business name and checks email and phone", () => {
    const a = analyseImport("retailers", `${H}Aurelia,Pune,Boutique,Asha,a@b.com,+91 90000 00000,@aurelia,https://a.example,Fine jewellery\n,Pune,,,,,,,\nX,,,,bad,,,,\n`);
    expect(a.report.rows.map((r) => r.status)).toEqual(["valid", "invalid", "invalid"]);
    expect(a.valid[0].parsed).toMatchObject({ resource: "retailers", input: { business: "Aurelia", location: "Pune", website: "https://a.example" } });
  });
  it("flags a repeat of business+place, email or phone, and ignores the app's 'Not recorded' placeholder", () => {
    const ctx: ImportContext = { ...EMPTY_CONTEXT, retailers: [{ id: "r1", business: "Aurelia Boutique", location: "Pune", email: "Not recorded", phone: "Not recorded" }, { id: "r2", business: "Zari", location: "", email: "z@z.com", phone: "Not recorded" }] };
    const csv = `${H}aurelia boutique,PUNE,,,,,,,\nAurelia Boutique,Mumbai,,,,,,,\nOther,,,,Z@Z.com,,,,\nNo Email One,,,,,,,,\nNo Email Two,,,,,,,,\n`;
    expect(status(csv, "retailers", ctx)).toEqual(["duplicate", "valid", "duplicate", "valid", "valid"]);
  });
});

describe("tasks", () => {
  const H = "title,priority,due\n";
  it("checks priority and due, defaults a blank priority to medium and a blank due to unscheduled", () => {
    const a = analyseImport("tasks", `${H}Call Asha,HIGH,Tomorrow\nPlain,,\nBad priority,urgent,\nBad date,low,12/31/2026\nGood date,low,2026-12-01\nImpossible date,low,2026-02-31\n,low,\n`);
    expect(a.report.rows.map((r) => r.status)).toEqual(["valid", "valid", "invalid", "invalid", "valid", "invalid", "invalid"]);
    expect(a.valid[0].parsed).toMatchObject({ input: { title: "Call Asha", priority: "high", due: "Tomorrow" } });
    expect(a.valid[1].parsed).toMatchObject({ input: { priority: "medium", due: "Unscheduled" } });
  });
  it("treats an open task with the same title as a duplicate but not a finished one (which the caller leaves out of the context)", () => {
    const ctx: ImportContext = { ...EMPTY_CONTEXT, tasks: [{ title: "Call Asha" }] };
    expect(status(`${H}call asha,,\nCall Meera,,\ncall meera,,\n`, "tasks", ctx)).toEqual(["duplicate", "valid", "duplicate"]);
    expect(status(`${H}call asha,,\n`, "tasks")).toEqual(["valid"]);
  });
});

describe("orders", () => {
  const C1 = "00000000-0000-4000-8000-000000000001", C2 = "00000000-0000-4000-8000-000000000002", C3 = "00000000-0000-4000-8000-000000000003", R1 = "00000000-0000-4000-8000-0000000000a1";
  const H = "channel,total,status,ordered_at,customer_email,retailer_business,items\n";
  const ctx: ImportContext = {
    ...EMPTY_CONTEXT,
    customers: [{ id: C1, name: "Meera", email: "meera@example.com", phone: "", instagram: "", city: "" }, { id: C2, name: "A", email: "twin@example.com", phone: "", instagram: "", city: "" }, { id: C3, name: "B", email: "twin@example.com", phone: "", instagram: "", city: "" }],
    retailers: [{ id: R1, business: "Aurelia Boutique", location: "Pune", email: "", phone: "" }],
    orders: [{ customerId: C1, retailerId: null, channel: "instagram", total: 1499, orderedAt: "2026-11-01T10:00:00.000Z" }],
  };
  it("looks customers and retailers up by email and name, and refuses unknown or ambiguous ones", () => {
    const a = analyseImport("orders", `${H}instagram,1499,paid,2026-11-04,MEERA@example.com,,\nb2b,5000,,,,aurelia boutique,\ninstagram,10,,,nobody@example.com,,\ninstagram,10,,,twin@example.com,,\nb2b,10,,,,Nowhere Shop,\n`, ctx);
    expect(a.report.rows.map((r) => r.status)).toEqual(["valid", "valid", "invalid", "invalid", "invalid"]);
    expect(a.report.rows[2].errors[0]).toMatch(/No existing customer/);
    expect(a.report.rows[3].errors[0]).toMatch(/More than one customer/);
    expect(a.valid[0].parsed).toMatchObject({ resource: "orders", input: { customerId: C1, retailerId: null, channel: "instagram", status: "paid", total: 1499 } });
    expect(a.valid[1].parsed).toMatchObject({ input: { retailerId: R1, status: "new" } });
  });
  it("validates channel, status, total and date, and accepts rupee signs and thousands separators", () => {
    const a = analyseImport("orders", `${H}etsy,10,,,,,\ninstagram,10,shipping,,,,\ninstagram,abc,,,,,\ninstagram,-5,,,,,\ninstagram,,,,,,\ninstagram,10,,04/11/2026,,,\ninstagram,"₹1,299.50",delivered,2026-11-04,,,\n`, ctx);
    expect(a.report.rows.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "valid"]);
    expect(a.valid[0].parsed).toMatchObject({ input: { total: 1299.5, status: "delivered" } });
  });
  it("turns items into line items with a quantity", () => {
    const a = analyseImport("orders", `${H}other,300,,,,,Kundan Choker x1; Pearl Studs x2; Plain Ring\n`, ctx);
    expect(a.valid[0].parsed).toMatchObject({ input: { lineItems: [{ name: "Kundan Choker", quantity: 1 }, { name: "Pearl Studs", quantity: 2 }, { name: "Plain Ring", quantity: 1 }] } });
  });
  it("flags an order that repeats an existing one (same buyer, channel, total and day) or an earlier row; rows with no date are never called duplicates", () => {
    const csv = `${H}instagram,1499,,2026-11-01,meera@example.com,,\ninstagram,1499,,2026-11-02,meera@example.com,,\ninstagram,1499,,2026-11-02,meera@example.com,,\ninstagram,20,,,,,\ninstagram,20,,,,,\n`;
    expect(status(csv, "orders", ctx)).toEqual(["duplicate", "valid", "duplicate", "valid", "valid"]);
  });
});
