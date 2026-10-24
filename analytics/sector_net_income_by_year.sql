-- Declared naive analyst fixture for the second metric. Same shape as the
-- revenue view, different SEC concept (NetIncomeLoss): facts summed by the
-- filing's fiscal_year. Anomalies are not planted. The dashboard window is
-- FY2016-FY2019. Corrections go to exhibit_a.*_v2, never in place.

CREATE OR REPLACE SCHEMASTORE VIEW analytics.sector_net_income_by_year AS
SELECT
  s.sic_division,
  f.fiscal_year,
  SUM(f.value_usd) AS net_income_usd
FROM (
  SELECT * FROM edgar.apple_netincome_table
  UNION ALL
  SELECT * FROM edgar.ibm_netincome_table
  UNION ALL
  SELECT * FROM edgar.oracle_netincome_table
  UNION ALL
  SELECT * FROM edgar.walmart_netincome_table
  UNION ALL
  SELECT * FROM edgar.target_netincome_table
  UNION ALL
  SELECT * FROM edgar.ford_netincome_table
  UNION ALL
  SELECT * FROM edgar.tesla_netincome_table
) f
LEFT JOIN sic_edgar_usl s
  ON s.cik = f.cik
WHERE f.fiscal_year BETWEEN 2016 AND 2019
GROUP BY s.sic_division, f.fiscal_year
