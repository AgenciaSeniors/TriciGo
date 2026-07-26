-- 00513: The SMS that tells a package recipient to follow their delivery links
--        to a page that does not exist.
--
-- notify_delivery_recipient_on_accept builds the tracking link as
--
--     'https://tricigo.com/delivery/' || v_share_token
--
-- but apps/web/src/app has no `delivery/` segment and next.config.ts had no
-- matching rewrite. The recipient — someone who is not a TriciGo user, whose
-- only contact with the product is this one SMS — gets a 404.
--
-- The page that actually renders a delivery for an anonymous recipient is
-- /track/share/[token] (apps/web/src/app/track/share/[token]/page.tsx). It
-- resolves the token through get_public_delivery_by_token and already shows the
-- package card. Nothing new needs building; the trigger was simply pointing at
-- the wrong path. That is also the shape packages/utils/src/shareRide.ts
-- (buildShareUrl) produces everywhere else in the product.
--
-- Chose to repoint the trigger rather than add a /delivery/ route, which would
-- duplicate that page. The companion web change adds a permanent redirect
-- /delivery/:token → /track/share/:token so any message already sent, or any
-- copy still carrying the old shape, resolves instead of 404ing.
--
-- Zero SMS have been sent with the broken link (no cargo ride has ever been
-- accepted in production), so there is nothing to reconcile.
--
-- DEPLOY ORDER: ship the web redirect BEFORE applying this, so the fallback is
-- live before the first recipient SMS goes out.

DO $patch$
DECLARE
  v_src TEXT;
BEGIN
  SELECT pg_get_functiondef('public.notify_delivery_recipient_on_accept()'::regprocedure)
    INTO v_src;

  IF position('tricigo.com/track/share/' IN v_src) > 0 THEN
    RAISE NOTICE '00513: recipient SMS already points at /track/share/ — skipping';
    RETURN;
  END IF;

  IF position('tricigo.com/delivery/' IN v_src) = 0 THEN
    RAISE EXCEPTION
      '00513: neither the old nor the new tracking URL found in notify_delivery_recipient_on_accept — refusing to apply a silent no-op';
  END IF;

  v_src := replace(v_src, 'https://tricigo.com/delivery/', 'https://tricigo.com/track/share/');

  EXECUTE v_src;
  RAISE NOTICE '00513: recipient SMS now links to /track/share/<token>';
END $patch$;
