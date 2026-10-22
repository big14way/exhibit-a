import {
  asSqlResult,
  executeWriteContract,
  signContract,
  verifyContract,
  type BaselineComparison,
  type RepairPlan,
  type SqlResult,
  type WriteContract,
} from "@exhibit-a/core";
import { canonicalAnnual, readCanonical } from "./edgar.ts";
import type { ToolRuntime } from "./runtime.ts";

export const SHADOW_CONTAINER = "exhibit_a_shadow";
export const SHADOW_VIEW_NAME = "sector_revenue_by_year";
export const SHADOW_METRIC = `${SHADOW_CONTAINER}.${SHADOW_VIEW_NAME}`;
export const CORRECTED_CONTAINER = "exhibit_a";
export const CORRECTED_VIEW_NAME = "sector_revenue_by_year_v2";
export const CORRECTED_METRIC = `${CORRECTED_CONTAINER}.${CORRECTED_VIEW_NAME}`;

const SAMPLE_CONTRACT_SECRET = "exhibit-a-sample-replay-contract-secret";

export function repairContractSecret(sampleMode: boolean): string {
  const configured = process.env.EXHIBIT_A_CONTRACT_SECRET;
  if (configured) return configured;
  if (sampleMode) return SAMPLE_CONTRACT_SECRET;
  throw new Error(
    "EXHIBIT_A_CONTRACT_SECRET is required for live shadow writes; add it to .env.local",
  );
}

function assertIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return value;
}

/**
 * Corrected metric body. The original view aggregates raw facts by the
 * filing's fiscal_year, so comparatives and later filings are counted again.
 * This body keeps one annual fact per (cik, period_end), last filed wins, then
 * sums by the period's calendar year (the same frame the SEC uses).
 */
export function correctedViewSql(
  sicTable = "edgar.sic_edgar_usl",
  startYear = 2016,
  endYear = 2019,
): string {
  const sic = assertIdentifier(sicTable, "SIC table");
  return `WITH annual AS (
  SELECT
    s.sic_division,
    f.cik,
    f.period_start,
    f.period_end,
    f.value_usd,
    f.filed_date,
    CASE
      WHEN MONTH(f.period_end) <= 6 THEN YEAR(f.period_end) - 1
      ELSE YEAR(f.period_end)
    END AS period_year,
    ROW_NUMBER() OVER (
      PARTITION BY f.cik, f.period_end
      ORDER BY f.filed_date DESC, f.value_usd DESC
    ) AS rn
  FROM (
    SELECT * FROM edgar.apple_revenue_table
    UNION ALL SELECT * FROM edgar.ibm_revenue_table
    UNION ALL SELECT * FROM edgar.oracle_revenue_table
    UNION ALL SELECT * FROM edgar.walmart_revenue_table
    UNION ALL SELECT * FROM edgar.target_revenue_table
    UNION ALL SELECT * FROM edgar.ford_revenue_table
    UNION ALL SELECT * FROM edgar.tesla_revenue_table
  ) f
  LEFT JOIN ${sic} s ON s.cik = f.cik
  WHERE DATEDIFF(f.period_end, f.period_start) BETWEEN 330 AND 400
)
SELECT
  sic_division,
  period_year AS fiscal_year,
  SUM(value_usd) AS revenue_usd
FROM annual
WHERE rn = 1
  AND period_year BETWEEN ${startYear} AND ${endYear}
GROUP BY sic_division, period_year`;
}

export function shadowViewStatement(body: string): string {
  return `CREATE OR REPLACE SCHEMASTORE VIEW ${SHADOW_VIEW_NAME} WITH CONTAINER ${SHADOW_CONTAINER} AS ${body}`;
}

export function shadowReadSql(view = SHADOW_METRIC): string {
  assertIdentifier(view, "shadow view");
  return `SELECT sic_division, fiscal_year, revenue_usd FROM ${view} ORDER BY fiscal_year, sic_division`;
}

export function buildRepairPlan(input: {
  stateId: string;
  metric: string;
  baseline: BaselineComparison;
  sampleMode: boolean;
  secret: string;
}): { plan: RepairPlan; contract: WriteContract } {
  const sicTable = process.env.ZETARIS_SIC_TABLE || "edgar.sic_edgar_usl";
  const correctedSql = correctedViewSql(sicTable);
  const statements = [
    `CREATE SCHEMASTORE CONTAINER ${SHADOW_CONTAINER}`,
    shadowViewStatement(correctedSql),
  ];
  const contract = signContract(
    {
      case_id: input.stateId,
      intent: `Create a verifier sandbox for ${input.metric}; do not modify the reported view`,
      scope: [SHADOW_METRIC],
      statements,
      cost_ceiling: 0,
      ttl_ms: input.sampleMode
        ? 365 * 24 * 60 * 60 * 1000
        : 15 * 60 * 1000,
      signer: "ScoutIntent",
    },
    input.secret,
  );
  const plan: RepairPlan = {
    metric: input.metric,
    shadow_metric: SHADOW_METRIC,
    corrected_metric: CORRECTED_METRIC,
    corrected_sql: correctedSql,
    statements,
    created_at: new Date().toISOString(),
  };
  return { plan, contract };
}

export function assertShadowContract(contract: WriteContract, plan: RepairPlan): void {
  if (!contract.scope.includes(plan.shadow_metric)) {
    throw new Error(`shadow contract does not scope ${plan.shadow_metric}`);
  }
  for (const statement of contract.statements) {
    const upper = statement.toUpperCase();
    if (upper.includes("ANALYTICS.")) {
      throw new Error("shadow contract must not touch the reported analytics view");
    }
    if (!upper.includes(SHADOW_CONTAINER.toUpperCase())) {
      throw new Error("shadow contract statement is outside the shadow container");
    }
  }
}

/**
 * In live mode this is the only write in the repair path. It creates an
 * isolated schema-store container and view; the original analytics view is
 * never named in a write statement. SAMPLE_MODE only verifies the signature.
 */
export async function ensureShadowView(input: {
  rt: ToolRuntime;
  plan: RepairPlan;
  contract: WriteContract;
  secret: string;
}): Promise<void> {
  assertShadowContract(input.contract, input.plan);
  verifyContract(input.contract, input.secret, { scope: input.plan.shadow_metric });
  if (input.rt.sampleMode) return;
  if (!input.rt.zetaris) {
    throw new Error("live shadow creation needs a Zetaris client");
  }
  await executeWriteContract(
    input.contract,
    input.secret,
    async (sql) => {
      try {
        await input.rt.zetaris!.runSql(sql, { mode: "write" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The container is idempotent; a second run should be able to replace
        // just the view. Do not swallow any other write error.
        if (/CREATE\s+SCHEMASTORE\s+CONTAINER/i.test(sql) && /exist/i.test(message)) {
          return;
        }
        throw err;
      }
    },
    { scope: input.plan.shadow_metric },
  );
}

/** Replay-side counterpart of the shadow view result. */
export function shadowResultFromFacts(
  canonicalFacts: SqlResult,
  startYear = 2016,
  endYear = 2019,
): SqlResult {
  const series = canonicalAnnual(readCanonical(canonicalFacts));
  const rows = series.rows
    .map((row) => {
      const frame = String(row[1]);
      return [row[0], Number(frame.replace(/^CY/, "")), row[2]] as unknown[];
    })
    .filter((row) => Number(row[1]) >= startYear && Number(row[1]) <= endYear)
    .sort((a, b) => Number(a[1]) - Number(b[1]) || String(a[0]).localeCompare(String(b[0])));
  return asSqlResult(["sic_division", "fiscal_year", "revenue_usd"], rows);
}
