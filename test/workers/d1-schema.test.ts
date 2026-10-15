import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface TableRow {
  name: string;
}

interface SweepRow {
  pending: number;
}

describe("D1 schema", () => {
  it("creates the practice tables and the sweep row", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<TableRow>();

    const names = tables.results.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["catalog", "repositories", "results", "sweep"]));
    const sweep = await env.DB.prepare("SELECT pending FROM sweep WHERE id = 1").first<SweepRow>();
    expect(sweep?.pending).toBe(0);
  });
});
