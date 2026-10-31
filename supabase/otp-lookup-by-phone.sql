-- ============================================================
-- Did a login code reach this phone?  (run read-only against prod)
-- ------------------------------------------------------------
-- One query, one phone. Edit the number on the first line (with or without
-- +53; spaces and dashes are ignored) and run it in the SQL Editor. It returns
-- one row per event, newest first, in Cuba time, from four places:
--
--   cuenta    auth.users + users: whose number it is, role, blocked or not.
--   SMS       sms_deliveries: what D7 / the carrier reported (kept long).
--             It cannot tell a login code from other SMS: the DLR webhook
--             overwrites raw_dlr, event_type included. Match it by time
--             against the "código" rows.
--   código    otp_codes: generated, used, expired or out of attempts. The
--             hourly cleanup keeps only the last ~2 hours.
--   contador  rate_limits (kept 30 days, 00636): the per-number buckets.
--
-- How to read the counters (limits must match send-sms-otp/index.ts,
-- verify-otp/index.ts and _shared/otp-budget.ts):
--   send-sms-otp:phone  10-min window, max 6. Each send D7 accepted counts 1;
--                       a failed send gives its token back, so count = 0 means
--                       the user asked and no SMS went out (D7 failed, or a
--                       day cap stopped it). Above 6, the extra are 429s.
--   otp-send-day        UTC day, max 15 codes sent. Above 15, the extra are 429s.
--   verify-otp:phone    10-min window, max 10 code checks, right or wrong.
--   link-phone:phone    the same, for linking a phone to an account.
--   otp-fail-day        UTC day, max 20 wrong codes (verify-otp + link-phone).
--                       At 20 the number cannot log in by code until 00:00 UTC.
--
-- otp_codes.attempts counts every check of that code, the right one included,
-- up to 5. A code typed after it expired never reaches the row
-- (verify_cuba_otp answers no_active_code), so a code that "venció sin usarse"
-- next to a verify-otp count means the user typed it too late.
-- ============================================================

WITH entrada AS (
  SELECT '55555555'::text AS numero,   -- el número, con o sin +53
         7                AS dias      -- cuántos días hacia atrás
),
p AS (
  SELECT CASE WHEN d ~ '^[56][0-9]{7}$' THEN '+53' || d ELSE '+' || d END AS phone,
         now() - make_interval(days => dias) AS desde
  FROM (SELECT regexp_replace(numero, '[^0-9]', '', 'g') AS d, dias FROM entrada) x
),
eventos AS (
  -- 1. Whose number it is
  SELECT 'infinity'::timestamptz AS ts, 'cuenta' AS fuente,
         COALESCE(
           (SELECT string_agg(format('%s (%s%s%s)', COALESCE(u.full_name, 'sin nombre'), COALESCE(u.role::text, 'sin perfil'),
                     CASE WHEN a.phone_confirmed_at IS NULL THEN ', teléfono sin confirmar' ELSE '' END,
                     CASE WHEN u.is_active = false THEN ', BLOQUEADA' ELSE '' END), '; ')
            FROM auth.users a LEFT JOIN public.users u ON u.id = a.id
            WHERE a.phone = ltrim(p.phone, '+')),
           'Ninguna cuenta tiene este número') AS que_paso,
         p.phone || CASE WHEN p.phone IN ('+5355550100', '+5355550101') THEN ' · número demo: nunca se manda SMS' ELSE '' END AS detalle
  FROM p
  UNION ALL
  -- 2. The SMS (D7)
  SELECT d.created_at, 'SMS',
         CASE d.status
           WHEN 'delivered'    THEN 'Llegó al celular'
           WHEN 'un_delivered' THEN 'NO se pudo entregar'
           WHEN 'sent' THEN CASE WHEN d.created_at < now() - interval '5 minutes'
                                 THEN 'D7 lo aceptó y nunca mandó acuse (no se sabe si llegó)'
                                 ELSE 'Enviado, esperando acuse' END
           ELSE d.status END,
         concat_ws(' · ',
           'acuse ' || to_char(COALESCE(d.delivered_at, d.last_event_at) AT TIME ZONE 'America/Havana', 'HH24:MI:SS'),
           'request ' || d.request_id)
  FROM sms_deliveries d, p WHERE d.recipient = p.phone AND d.created_at >= p.desde
  UNION ALL
  -- 3. The code (only the last ~2 hours are kept)
  SELECT o.created_at, 'código',
         CASE WHEN o.verified_at IS NOT NULL THEN 'Lo usó para entrar'
              WHEN o.attempts >= 5           THEN 'Agotado: 5 intentos equivocados'
              WHEN o.expires_at < now()      THEN 'Venció sin usarse'
              ELSE 'Vigente, todavía sin usar' END,
         format('%s intento(s)', o.attempts)
           || COALESCE(' · usado ' || to_char(o.verified_at AT TIME ZONE 'America/Havana', 'HH24:MI:SS'), '')
  FROM otp_codes o, p WHERE o.phone = p.phone AND o.created_at >= p.desde
  UNION ALL
  -- 4. Rate-limit counters (kept 30 days)
  SELECT r.window_start, 'contador',
         CASE
           WHEN r.key LIKE 'send-sms-otp:phone:%' THEN
             CASE WHEN r.count = 0 THEN 'Pidió código y NO salió ningún SMS (falló D7 o un tope diario)'
                  WHEN r.count = 1 THEN 'Salió 1 SMS hacia D7'
                  WHEN r.count <= 6 THEN format('Salieron %s SMS hacia D7', r.count)
                  ELSE format('Salieron 6 SMS; %s pedido(s) rechazado(s) por límite (6 cada 10 min)', r.count - 6) END
           WHEN r.key LIKE 'otp-send-day:%' THEN
             CASE WHEN r.count > 15 THEN format('TOPE DEL DÍA: %s pedido(s) rechazado(s) (máx. 15 códigos por día)', r.count - 15)
                  ELSE format('%s código(s) pedido(s) en el día (tope 15)', r.count) END
           WHEN r.key LIKE 'verify-otp:phone:%' THEN
             CASE WHEN r.count > 10 THEN format('Probó códigos; %s intento(s) rechazado(s) por límite (10 cada 10 min)', r.count - 10)
                  ELSE format('Escribió %s código(s) en la app', r.count) END
           WHEN r.key LIKE 'link-phone:phone:%' THEN format('Vincular teléfono: %s intento(s) de código', r.count)
           WHEN r.key LIKE 'otp-fail-day:%' THEN
             CASE WHEN r.count >= 20 THEN format('BLOQUEADO: %s códigos equivocados en el día; no puede entrar hasta las 00:00 UTC', r.count)
                  ELSE format('%s código(s) equivocado(s) en el día (tope 20)', r.count) END
         END,
         CASE WHEN r.key LIKE 'otp-%' THEN 'todo el día ' || to_char(r.window_start AT TIME ZONE 'UTC', 'DD/MM') || ' (UTC)'
              ELSE 'ventana de 10 min' END
  FROM rate_limits r, p
  WHERE r.key IN ('send-sms-otp:phone:' || p.phone, 'otp-send-day:' || p.phone, 'verify-otp:phone:' || p.phone,
                  'link-phone:phone:' || p.phone, 'otp-fail-day:' || p.phone)
    AND r.window_start >= p.desde - interval '1 day'
)
SELECT CASE WHEN ts = 'infinity' THEN '—' ELSE to_char(ts AT TIME ZONE 'America/Havana', 'DD/MM HH24:MI') END AS hora_cuba,
       fuente, que_paso, detalle
FROM eventos
ORDER BY ts DESC, fuente
LIMIT 60;
