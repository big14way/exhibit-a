import type { SqlResult } from "@exhibit-a/core";

export const EDGAR_COMPANIES = [
  {
    cik: "0000320193",
    ticker: "AAPL",
    entity_name: "Apple Inc.",
    table: "edgar.apple_revenue_table",
    sic: "3571",
    sic_division: "Manufacturing",
  },
  {
    cik: "0000051143",
    ticker: "IBM",
    entity_name: "International Business Machines Corporation",
    table: "edgar.ibm_revenue_table",
    sic: "7370",
    sic_division: "Services",
  },
  {
    cik: "0001341439",
    ticker: "ORCL",
    entity_name: "Oracle Corporation",
    table: "edgar.oracle_revenue_table",
    sic: "7372",
    sic_division: "Services",
  },
  {
    cik: "0000104169",
    ticker: "WMT",
    entity_name: "Walmart Inc.",
    table: "edgar.walmart_revenue_table",
    sic: "5331",
    sic_division: "Retail Trade",
  },
  {
    cik: "0000027419",
    ticker: "TGT",
    entity_name: "Target Corporation",
    table: "edgar.target_revenue_table",
    sic: "5331",
    sic_division: "Retail Trade",
  },
  {
    cik: "0000037996",
    ticker: "F",
    entity_name: "Ford Motor Co",
    table: "edgar.ford_revenue_table",
    sic: "3711",
    sic_division: "Manufacturing",
  },
  {
    cik: "0001318605",
    ticker: "TSLA",
    entity_name: "Tesla, Inc.",
    table: "edgar.tesla_revenue_table",
    sic: "3711",
    sic_division: "Manufacturing",
  },
] as const;

export function unionFactsSql(): string {
  return EDGAR_COMPANIES.map((company) => `SELECT * FROM ${company.table}`).join("\n  UNION ALL\n  ");
}

export function companyBucketsSql(): string {
  return EDGAR_COMPANIES.map(
    (company) =>
      `SELECT '${company.cik}' AS cik, '${company.entity_name}' AS entity_name, fiscal_year, COUNT(*) AS rows_n, COUNT(DISTINCT period_end) AS distinct_periods, SUM(value_usd) AS revenue_usd FROM ${company.table} GROUP BY fiscal_year`,
  ).join("\n  UNION ALL\n  ") + "\nORDER BY cik, fiscal_year";
}

export function duplicationSql(): string {
  return `SELECT cik, COUNT(*) AS rows_total, COUNT(DISTINCT period_end) AS distinct_periods, COUNT(*) - COUNT(DISTINCT period_end) AS duplicate_rows
FROM (
  ${unionFactsSql()}
) f
GROUP BY cik
ORDER BY cik`;
}

export function bucketSql(startYear = 2016, endYear = 2019): string {
  return `SELECT fiscal_year, COUNT(*) AS rows_n, COUNT(DISTINCT period_end) AS distinct_periods, SUM(value_usd) AS revenue_usd
FROM (
  ${unionFactsSql()}
) f
WHERE fiscal_year >= ${startYear} AND fiscal_year <= ${endYear}
GROUP BY fiscal_year
ORDER BY fiscal_year`;
}

export function canonicalFactsSql(sicTable = "sic_edgar_usl"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(sicTable)) {
    throw new Error(`invalid SIC table name: ${sicTable}`);
  }
  return `SELECT s.sic_division, f.cik, f.period_start, f.period_end, f.period_frame, f.value_usd, f.filed_date
FROM (
  ${unionFactsSql()}
) f
LEFT JOIN ${sicTable} s ON s.cik = f.cik
ORDER BY f.cik, f.period_end, f.filed_date`;
}

export type CoverageRow = {
  cik: string;
  entity_name: string;
  fiscal_year: number;
  rows_n: number;
  distinct_periods: number;
  revenue_usd: number;
};

export type DuplicationRow = {
  cik: string;
  rows_total: number;
  distinct_periods: number;
  duplicate_rows: number;
};

export type BucketRow = {
  fiscal_year: number;
  rows_n: number;
  distinct_periods: number;
  revenue_usd: number;
};

export type CanonicalRow = {
  sic_division: string;
  cik: string;
  period_start: string;
  period_end: string;
  period_frame: string | null;
  value_usd: number;
  filed_date: string;
};

function indexOf(columns: string[], name: string): number {
  const index = columns.indexOf(name);
  if (index < 0) throw new Error(`result has no column ${name}: ${columns.join(", ")}`);
  return index;
}

export function readCoverage(result: SqlResult): CoverageRow[] {
  const cik = indexOf(result.columns, "cik");
  const entity = indexOf(result.columns, "entity_name");
  const year = indexOf(result.columns, "fiscal_year");
  const rows = indexOf(result.columns, "rows_n");
  const periods = indexOf(result.columns, "distinct_periods");
  const revenue = indexOf(result.columns, "revenue_usd");
  return result.rows.map((row) => ({
    cik: String(row[cik]),
    entity_name: String(row[entity]),
    fiscal_year: Number(row[year]),
    rows_n: Number(row[rows]),
    distinct_periods: Number(row[periods]),
    revenue_usd: Number(row[revenue]),
  }));
}

export function readDuplication(result: SqlResult): DuplicationRow[] {
  const cik = indexOf(result.columns, "cik");
  const total = indexOf(result.columns, "rows_total");
  const distinct = indexOf(result.columns, "distinct_periods");
  const duplicates = indexOf(result.columns, "duplicate_rows");
  return result.rows.map((row) => ({
    cik: String(row[cik]),
    rows_total: Number(row[total]),
    distinct_periods: Number(row[distinct]),
    duplicate_rows: Number(row[duplicates]),
  }));
}

export function readBuckets(result: SqlResult): BucketRow[] {
  const year = indexOf(result.columns, "fiscal_year");
  const rows = indexOf(result.columns, "rows_n");
  const distinct = indexOf(result.columns, "distinct_periods");
  const revenue = indexOf(result.columns, "revenue_usd");
  return result.rows.map((row) => ({
    fiscal_year: Number(row[year]),
    rows_n: Number(row[rows]),
    distinct_periods: Number(row[distinct]),
    revenue_usd: Number(row[revenue]),
  }));
}

export function readCanonical(result: SqlResult): CanonicalRow[] {
  const division = indexOf(result.columns, "sic_division");
  const cik = indexOf(result.columns, "cik");
  const start = indexOf(result.columns, "period_start");
  const end = indexOf(result.columns, "period_end");
  const frame = indexOf(result.columns, "period_frame");
  const value = indexOf(result.columns, "value_usd");
  const filed = indexOf(result.columns, "filed_date");
  return result.rows.map((row) => ({
    sic_division: String(row[division]),
    cik: String(row[cik]),
    period_start: String(row[start]),
    period_end: String(row[end]),
    period_frame: String(row[frame] ?? ""),
    value_usd: Number(row[value]),
    filed_date: String(row[filed]),
  }));
}

/** SEC frames label a period by the calendar year holding most of it. */
export function annualFrame(periodEnd: string): string {
  const date = new Date(periodEnd);
  const year = date.getUTCMonth() + 1 <= 6 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
  return `CY${year}`;
}

function frameLabel(row: CanonicalRow): string {
  return typeof row.period_frame === "string" && /^CY\d{4}$/.test(row.period_frame)
    ? row.period_frame
    : annualFrame(row.period_end);
}

function durationDays(start: string, end: string): number {
  return (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
}

/**
 * One annual value per (cik, period_end): the last filed row wins. Duration is
 * checked in code because the SEC frame tag is sparse on comparative rows.
 */
export function canonicalAnnual(
  rows: CanonicalRow[],
): { columns: string[]; rows: unknown[][]; byCik: Map<string, Map<string, number>> } {
  const latest = new Map<string, CanonicalRow>();
  for (const row of rows) {
    const days = durationDays(row.period_start, row.period_end);
    if (days < 330 || days > 400) continue;
    const key = `${row.cik}|${row.period_end}`;
    const current = latest.get(key);
    if (!current || row.filed_date > current.filed_date) latest.set(key, row);
  }
  const byCik = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const row of latest.values()) {
    const frame = frameLabel(row);
    const frames = byCik.get(row.cik) ?? new Map<string, number>();
    frames.set(frame, row.value_usd);
    byCik.set(row.cik, frames);
    const key = `${row.sic_division}|${frame}`;
    totals.set(key, (totals.get(key) ?? 0) + row.value_usd);
  }
  const out: unknown[][] = [];
  for (const [key, value] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [division, frame] = key.split("|");
    out.push([division, frame, value]);
  }
  return { columns: ["sic_division", "period_frame", "revenue_usd"], rows: out, byCik };
}

export const CANONICAL_COLUMNS = ["sic_division", "period_frame", "revenue_usd"] as const;
