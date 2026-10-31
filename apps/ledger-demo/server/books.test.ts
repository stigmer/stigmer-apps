/**
 * The books and the fixtures together: Northwind's quarter has one miscoding that is exactly its
 * Marketing overspend and its Software underspend, Blue Fern's has none, and an adjustment moves
 * money only inside the customer it names.
 */
import { describe, expect, it } from "vitest";
import { ACCOUNTS, CUSTOMERS, customerBySlug, ledgerCsv } from "../fixtures/books.js";
import { AdjustmentRefused, Books } from "./books.js";

const northwind = customerBySlug("northwind-books")!;
const blueFern = customerBySlug("blue-fern-press")!;
const variance = (books: Books, slug: string, account: string) =>
  books.view(customerBySlug(slug)!).accounts.find((a) => a.account === account)!.variance;

describe("the quarter", () => {
  it("makes Northwind's one miscoded line the whole of Marketing's overspend and Software's underspend", () => {
    const books = new Books(CUSTOMERS);
    const miscoded = northwind.lines.filter((l) => l.vendor === "Pixelform");
    expect(miscoded).toHaveLength(1);
    expect(variance(books, "northwind-books", "Marketing")).toBe(miscoded[0]!.amount);
    expect(variance(books, "northwind-books", "Software")).toBe(-miscoded[0]!.amount);
  });

  it("keeps Blue Fern's quarter within ten percent on every account", () => {
    const books = new Books(CUSTOMERS);
    for (const a of books.view(blueFern).accounts) expect(Math.abs(a.variance)).toBeLessThanOrEqual(a.budget * 0.1);
  });

  it("prints each customer's quarter as the CSV the presenter attaches", () => {
    const csv = ledgerCsv(northwind).trim().split("\n");
    expect(csv[0]).toBe("date,vendor,description,account,amount");
    expect(csv).toHaveLength(northwind.lines.length + 1);
    expect(csv).toContain('2026-08-11,Pixelform,"Design tool, annual subscription, 20 seats",Marketing,4800');
  });
});

describe("Books.post", () => {
  it("moves the amount between two accounts of that customer only", () => {
    const books = new Books(CUSTOMERS);
    books.post(northwind, { from: "Marketing", to: "Software", amount: 4800, reason: "Pixelform is a software tool", by: "Dana" });
    expect(variance(books, "northwind-books", "Marketing")).toBe(0);
    expect(variance(books, "northwind-books", "Software")).toBe(0);
    expect(books.view(blueFern).adjustments).toEqual([]);
  });

  it.each([
    [{ from: "Marketing", to: "Marketing", amount: 10 }, "differ"],
    [{ from: "Marketing", to: "Payroll", amount: 10 }, ACCOUNTS.join(", ")],
    [{ from: "Marketing", to: "Software", amount: 0 }, "more than 0"],
    [{ from: "Marketing", to: "Software", amount: Number.NaN }, "more than 0"],
    [{ from: "Marketing", to: "Software", amount: 2_000_000 }, "at most"],
  ])("refuses %o", (input, words) => {
    const books = new Books(CUSTOMERS);
    expect(() => books.post(northwind, { ...input, reason: "x", by: "Dana" })).toThrow(AdjustmentRefused);
    expect(() => books.post(northwind, { ...input, reason: "x", by: "Dana" })).toThrow(words);
    expect(books.view(northwind).adjustments).toEqual([]);
  });

  it("refuses an empty reason", () => {
    expect(() => new Books(CUSTOMERS).post(northwind, { from: "Marketing", to: "Software", amount: 1, reason: "  ", by: "Dana" })).toThrow(
      AdjustmentRefused,
    );
  });

  it("starts the quarter over on reset", () => {
    const books = new Books(CUSTOMERS);
    books.post(northwind, { from: "Marketing", to: "Software", amount: 4800, reason: "r", by: "Dana" });
    books.reset();
    expect(books.view(northwind).adjustments).toEqual([]);
  });
});
