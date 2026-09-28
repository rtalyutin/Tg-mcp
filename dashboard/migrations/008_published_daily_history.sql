-- Only committed, reviewed fields are exposed to the HTTP reader.
-- The underlying daily result, including dialog_scan, stays private.
CREATE VIEW dashboard.published_daily_history WITH (security_barrier=true) AS
SELECT report_date, state, coverage, result_payload, group_memberships, changes
FROM dashboard.daily_result
WHERE state IN ('applied', 'baseline_only');

REVOKE ALL ON dashboard.published_daily_history FROM PUBLIC;
