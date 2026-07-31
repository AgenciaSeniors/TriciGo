-- Post-apply verification for migrations 00531-00535 (partner places & arrival coupons).
--
-- Run this AFTER applying those five migrations, as the person who applies them.
--
-- Everything happens inside a transaction that is rolled back. That is safe even
-- though the trigger sends a push: net.http_post enqueues into
-- net.http_request_queue, which IS transactional, so the ROLLBACK cancels it.
-- Nothing reaches a real passenger and nothing is left behind.
--
-- Read it as a table: every row must have got = want. This exact script was run
-- against a real Postgres before being committed, and all nine rows matched.

BEGIN;

-- ── Fixtures ──────────────────────────────────────────────────────────
-- Two businesses. The second exists to prove a coupon cannot be redeemed at the
-- wrong counter, which is the whole point of the per-business validation link.
--
-- No hardcoded UUIDs: the database generates them and we look them up by name.
-- A fixed id collides with leftover data and turns a green run red for no reason
-- (this happened while writing this script).
INSERT INTO partner_places (name, location, benefit_title, benefit_description, radius_m, coupon_ttl_minutes)
VALUES ('QA VERIFY Panadería', ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography,
        'Café gratis', 'Un café con tu compra', 80, 120),
       ('QA VERIFY Cafetería', ST_SetSRID(ST_MakePoint(-82.3800, 23.1300), 4326)::geography,
        '2x1 en helados', 'Dos por uno', 80, 120);

-- ── Drive the trigger ─────────────────────────────────────────────────
-- Self-sufficient on purpose. An earlier version looked for an existing
-- non-completed ride, and on a database where every ride happened to be
-- completed it silently issued nothing — which reads exactly like a broken
-- trigger. Instead we take any passenger ride and push it back a state, so the
-- UPDATE below ALWAYS crosses the edge the trigger watches. All rolled back.
UPDATE rides SET status = 'accepted'
WHERE id = (SELECT id FROM rides WHERE ride_mode = 'passenger' LIMIT 1);

UPDATE rides SET
  status = 'completed',
  dropoff_location = ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography
WHERE id = (SELECT id FROM rides WHERE ride_mode = 'passenger' AND status = 'accepted' LIMIT 1);

-- Cargo must issue nothing: in mensajería the customer is the SENDER and the
-- dropoff is the recipient's address, so nobody the coupon belongs to went there.
UPDATE rides SET status = 'accepted'
WHERE id = (SELECT id FROM rides WHERE ride_mode = 'cargo' LIMIT 1);

UPDATE rides SET
  status = 'completed',
  dropoff_location = ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography
WHERE id = (SELECT id FROM rides WHERE ride_mode = 'cargo' AND status = 'accepted' LIMIT 1);

-- ── Checks ────────────────────────────────────────────────────────────
WITH pan AS (SELECT id, validation_token FROM partner_places WHERE name = 'QA VERIFY Panadería'),
     caf AS (SELECT id, validation_token FROM partner_places WHERE name = 'QA VERIFY Cafetería'),
     cup AS (SELECT code FROM partner_coupons WHERE partner_place_id = (SELECT id FROM pan) LIMIT 1)
SELECT * FROM (
  -- Check 0 exists so a zero further down is never ambiguous. The trigger
  -- swallows its own errors by design (a marketing perk must never block a ride
  -- completing or being paid), so without this a broken function and an empty
  -- fixture look identical.
  SELECT 0 AS n, '0 precondition: rides pushed' AS check,
    (SELECT count(*)::text FROM rides WHERE status = 'completed'
       AND ST_DWithin(dropoff_location, ST_SetSRID(ST_MakePoint(-82.3666,23.1357),4326)::geography, 80)) AS got,
    '>= 1' AS want

  UNION ALL SELECT 1, '1 token auto-generated, 12 hex',
    (SELECT count(*) FILTER (WHERE validation_token ~ '^[0-9a-f]{12}$')::text
       FROM partner_places WHERE name LIKE 'QA VERIFY%'), '2'

  UNION ALL SELECT 2, '2 passenger ride inside radius issues one',
    (SELECT count(*)::text FROM partner_coupons WHERE partner_place_id = (SELECT id FROM pan)), '1'

  -- Still 1, not 2: the cargo ride above landed on the same spot and must have
  -- issued nothing.
  UNION ALL SELECT 3, '3 cargo ride issues nothing',
    (SELECT count(*)::text FROM partner_coupons WHERE partner_place_id = (SELECT id FROM pan)), '1'

  UNION ALL SELECT 4, '4 code uses unambiguous alphabet',
    (SELECT bool_and(code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$')::text
       FROM partner_coupons WHERE partner_place_id = (SELECT id FROM pan)), 'true'

  UNION ALL SELECT 5, '5 validate with the right token',
    validate_partner_coupon((SELECT validation_token FROM pan), (SELECT code FROM cup)) ->> 'status', 'valid'

  -- The scoping win. Same live code, wrong business: must be indistinguishable
  -- from a code that never existed.
  UNION ALL SELECT 6, '6 same code at the wrong business',
    validate_partner_coupon((SELECT validation_token FROM caf), (SELECT code FROM cup)) ->> 'status', 'not_found'

  UNION ALL SELECT 7, '7 unknown token leaks nothing',
    validate_partner_coupon('ffffffffffff','ZZZZZZ') ->> 'status', 'invalid_link'

  UNION ALL SELECT 8, '8 redeem once',
    redeem_partner_coupon((SELECT validation_token FROM pan), (SELECT code FROM cup)) ->> 'status', 'redeemed'

  UNION ALL SELECT 9, '9 redeem twice',
    redeem_partner_coupon((SELECT validation_token FROM pan), (SELECT code FROM cup)) ->> 'status', 'used'
) q ORDER BY n;

-- ── Rate-limit buckets ────────────────────────────────────────────────
-- Must key on a partner_place_id UUID, or be the single shared bad-token bucket.
-- A key containing an IP would mean the forgeable per-IP derivation came back:
-- X-Forwarded-For is written by the caller, so keying on it let an attacker both
-- bypass the budget and pin a chosen shop's bucket to deny it service.
SELECT 'buckets key on the business' AS check,
       coalesce(bool_and(key ~ '^coupon_(validate|redeem):[0-9a-f-]{36}$'
                         OR key = 'coupon_badtoken:all')::text, 'no rows yet') AS got,
       'true' AS want
FROM rate_limits WHERE key LIKE 'coupon%';

ROLLBACK;
