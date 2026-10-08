-- Seed for the 00636 rehearsal: rate_limits rows at known ages, shaped like prod's
-- (one row per key and fixed window; keys are '<function>:<ip|phone|user>').
-- Ages are relative to now() at seed time; the suite runs within seconds of it.
--
--   49 expired rows (window_start older than 30 days)
--     45  keepwarm one-hit buckets from our pg_net IP, 31 days old and up (hourly)
--      3  rows from June, 120 days old (the oldest in prod is 2026-06-07)
--      1  boundary row, 30 days + 10 minutes old
--    8 rows that must survive
--      1  boundary row, 30 days - 10 minutes old
--      1  29 days old (SMS per phone)
--      1  3 days old (verify-otp per IP)
--      2  open 24 h windows, 20 h and 23 h old, at their caps (foreign SMS, SOS per day)
--      1  open 10 min window (SMS per IP)
--      2  last hour (health-check)
INSERT INTO public.rate_limits (key, window_start, count)
SELECT 'create-netopia-pi:44.234.196.74',
       date_trunc('minute', now()) - interval '31 days' - g * interval '1 hour', 1
FROM generate_series(0, 44) AS g;

INSERT INTO public.rate_limits (key, window_start, count) VALUES
  ('send-sms-otp:phone:+5355500001', date_trunc('minute', now()) - interval '120 days', 1),
  ('verify-otp:189.126.33.82',      date_trunc('minute', now()) - interval '120 days' + interval '1 minute', 2),
  ('send-push:44.234.196.74',       date_trunc('minute', now()) - interval '120 days' + interval '2 minutes', 4),
  ('link-phone:189.126.33.212',     now() - interval '30 days' - interval '10 minutes', 1),
  ('link-phone:189.126.33.215',     now() - interval '30 days' + interval '10 minutes', 1),
  ('send-sms-otp:phone:+5355500002', now() - interval '29 days', 2),
  ('verify-otp:185.184.192.221',    now() - interval '3 days', 3),
  ('send-sms-otp:foreign:daily',    now() - interval '20 hours', 20),
  ('broadcast-emergency:day:a0000000-0000-4000-8000-000000000001', now() - interval '23 hours', 10),
  ('send-sms-otp:189.126.33.82',    now() - interval '5 minutes', 30),
  ('health-check:189.126.33.82',    date_trunc('minute', now()) - interval '50 minutes', 1),
  ('health-check:185.184.192.221',  date_trunc('minute', now()) - interval '10 minutes', 1);
