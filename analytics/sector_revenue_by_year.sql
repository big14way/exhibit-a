-- Declared naive analyst fixture. Anomalies are not planted; they come from
-- how SEC companyconcept facts behave when summed by filing fiscal_year.
-- The dashboard window is FY2016-FY2019. Do not replace this view in place;
-- corrections go to exhibit_a.*_v2.

CREATE OR REPLACE SCHEMASTORE VIEW analytics.sector_revenue_by_year AS
SELECT
  s.sic_division,
  f.fiscal_year,
  SUM(f.value_usd) AS revenue_usd
FROM (
  SELECT * FROM edgar.apple_revenue_table
  UNION ALL
  SELECT * FROM edgar.ibm_revenue_table
  UNION ALL
  SELECT * FROM edgar.oracle_revenue_table
  UNION ALL
  SELECT * FROM edgar.walmart_revenue_table
  UNION ALL
  SELECT * FROM edgar.target_revenue_table
  UNION ALL
  SELECT * FROM edgar.ford_revenue_table
  UNION ALL
  SELECT * FROM edgar.tesla_revenue_table
) f
LEFT JOIN sic_edgar_usl s
  ON s.cik = f.cik
WHERE f.fiscal_year BETWEEN 2016 AND 2019
GROUP BY s.sic_division, f.fiscal_year
