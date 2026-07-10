-- ============================================================
-- SMS / OTP delivery health check  (run read-only against prod)
-- ------------------------------------------------------------
-- Surfaces the OTP-delivery problems found 2026-07-10. The OTP send path
-- (send-sms-otp) reports success as soon as D7 ACCEPTS the message (HTTP 200 +
-- request_id) — the real carrier outcome lands only here, in sms_deliveries,
-- via the process-sms-dlr webhook. So this table is the ONLY place a "code
-- enviado pero no llegó" failure is visible. Check it, not the function logs.
--
-- Healthy baseline (2026-07-10): +53 5X ~99% delivered; +53 6X 0% delivered.
-- ============================================================

-- 1) Delivery outcome by ETECSA prefix (last 14 days).
--    RED FLAG: any prefix with 0 rows in `delivered` but rows in
--    un_delivered/sent → that whole number range is broken (the +53 6X bug).
SELECT substring(regexp_replace(recipient,'^\+?53',''),1,1) AS etecsa_prefix,
       count(*) FILTER (WHERE status='delivered')    AS delivered,
       count(*) FILTER (WHERE status='un_delivered') AS un_delivered,
       count(*) FILTER (WHERE status='sent')         AS stuck_sent,
       count(*)                                       AS total,
       round(100.0*count(*) FILTER (WHERE status='delivered')/nullif(count(*),0),1) AS pct_delivered
FROM sms_deliveries
WHERE created_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1;

-- 2) Numbers that NEVER got a confirmed delivery (candidates to reach out to /
--    escalate to D7). Excludes numbers with at least one 'delivered'.
SELECT recipient,
       count(*) AS attempts,
       count(*) FILTER (WHERE status='un_delivered') AS un_delivered,
       min(sent_at) AS first, max(sent_at) AS last
FROM sms_deliveries
WHERE created_at > now() - interval '30 days'
GROUP BY recipient
HAVING count(*) FILTER (WHERE status='delivered') = 0
ORDER BY attempts DESC;

-- 3) Phones self-locked by the per-phone rate limit (count>PHONE_MAX=6).
--    After the 00491 refund fix, a phone should only appear here if it made
--    >6 *accepted* sends in one 10-min window (genuine spam), NOT because its
--    sends failed. A failing number showing up here = refund not working.
SELECT split_part(key,':',3) AS phone, count, window_start
FROM rate_limits
WHERE key LIKE 'send-sms-otp:phone:%'
  AND count > 6
  AND split_part(key,':',3) NOT IN ('+5355550100','+5355550101')   -- demo accounts
  AND window_start > now() - interval '7 days'
ORDER BY count DESC, window_start DESC;

-- 4) IPs self-locked by the per-IP limit (count>IP_MAX=30). Shared ETECSA
--    CGNAT IPs (152.206/152.207/169.158/190.6/200.0.16) reaching the cap means
--    the limit is still too tight for carrier NAT — raise IP_MAX further.
SELECT split_part(key,':',2) AS ip, count, window_start,
       (split_part(key,':',2) ~ '^(152\.206|152\.207|169\.158|190\.6|200\.0\.16)') AS looks_etecsa
FROM rate_limits
WHERE key LIKE 'send-sms-otp:%'
  AND key NOT LIKE 'send-sms-otp:phone:%'
  AND count > 30
  AND window_start > now() - interval '7 days'
ORDER BY count DESC;
