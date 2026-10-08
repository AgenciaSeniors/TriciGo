-- 00638: tuteo in the last two server-side push texts that still used voseo.
--
-- TriciGo copy is tuteo (tú), never voseo. A read-only scan of prod on
-- 2026-10-07 (pg_proc.prosrc of every public function, every platform_config
-- value, every cms_content title and body) found voseo in two trigger
-- functions only. Both send a push through send-push:
--   notify_payment_intent_failure       'Intentalo nuevamente.'               -> 'Inténtalo nuevamente.'
--   notify_rider_gps_override_request   'Abrí la app y confirmá si lo ves.'   -> 'Abre la app y confirma si lo ves.'
--
-- Each body is patched in place from the live catalog (pg_get_functiondef +
-- replace) instead of being rewritten from git. Prod's bodies are not the ones
-- in git (00450 carries an AUD-019 comment that prod's body does not have),
-- and a rewrite could drop whatever prod has that git lacks. Since the new
-- body comes from the catalog, pasting this file from Windows (CRLF) into the
-- SQL Editor cannot put a \r into either function: the replaced texts are
-- single-line literals.
--
-- Per function:
--   - missing function: abort (its trigger would be failing on every call);
--   - body already patched (md5 is the patched one): skip, so the file can
--     run twice;
--   - the text to replace must appear exactly once;
--   - the body must be the one measured in prod on 2026-10-07 (md5 below);
--     any other body was changed after this file was written and is refused;
--   - after the patch, the body must have the expected md5, and owner and
--     grants must be the ones it had (CREATE OR REPLACE keeps the oid, so the
--     comment and the triggers stay attached).
-- The file ends asserting that both bodies are the patched ones and that no
-- voseo form is left in them.
--
-- md5(prosrc), measured in prod and in the rehearsal:
--   notify_payment_intent_failure       9d1708844cefd005f66fd750b722ff46 -> b8b2e9be09e55766cbdd1406fa9d6121
--   notify_rider_gps_override_request   e702e178b3abc97548db19a219280ab1 -> 919ef4587bcf09fcc9690b63d5a375ea
--
-- Rehearsal: supabase/tests/00638/run.sh

DO $patch$
DECLARE
  r       record;
  v_oid   oid;
  v_def   text;
  v_md5   text;
  v_acl   text;
  v_owner oid;
  v_hits  integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.notify_payment_intent_failure()',
       '9d1708844cefd005f66fd750b722ff46',
       'b8b2e9be09e55766cbdd1406fa9d6121',
       'no pudo procesarse. Intentalo nuevamente.',
       'no pudo procesarse. Inténtalo nuevamente.'),
      ('public.notify_rider_gps_override_request()',
       'e702e178b3abc97548db19a219280ab1',
       '919ef4587bcf09fcc9690b63d5a375ea',
       'Abrí la app y confirmá si lo ves.',
       'Abre la app y confirma si lo ves.')
    ) AS t(sig, md5_before, md5_after, old_text, new_text)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION '00638: % does not exist; refusing to continue', r.sig;
    END IF;

    SELECT md5(p.prosrc), p.proacl::text, p.proowner
      INTO v_md5, v_acl, v_owner
      FROM pg_proc p WHERE p.oid = v_oid;

    IF v_md5 = r.md5_after THEN
      RAISE NOTICE '00638: % already patched; skipping', r.sig;
      CONTINUE;
    END IF;

    v_def := pg_get_functiondef(v_oid);
    v_hits := (length(v_def) - length(replace(v_def, r.old_text, ''))) / length(r.old_text);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '00638: expected the text to replace once in %, found it % times (body md5 %)',
        r.sig, v_hits, v_md5;
    END IF;

    IF v_md5 <> r.md5_before THEN
      RAISE EXCEPTION '00638: % has body md5 %, not % (prod, 2026-10-07); refusing to patch a body this file was not written against',
        r.sig, v_md5, r.md5_before;
    END IF;

    EXECUTE replace(v_def, r.old_text, r.new_text);

    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM r.md5_after THEN
      RAISE EXCEPTION '00638: % does not have the expected body after the patch', r.sig;
    END IF;
    IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_acl
       OR (SELECT p.proowner FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION '00638: the owner or the grants of % changed during the patch', r.sig;
    END IF;

    RAISE NOTICE '00638: patched %', r.sig;
  END LOOP;
END
$patch$;

DO $assert$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(t.sig, ', ' ORDER BY t.sig)
    INTO v_bad
    FROM (VALUES
      ('public.notify_payment_intent_failure()',
       'b8b2e9be09e55766cbdd1406fa9d6121',
       'no pudo procesarse. Inténtalo nuevamente.'),
      ('public.notify_rider_gps_override_request()',
       '919ef4587bcf09fcc9690b63d5a375ea',
       'Abre la app y confirma si lo ves.')
    ) AS t(sig, md5_after, new_text)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
   WHERE p.oid IS NULL
      OR md5(p.prosrc) <> t.md5_after
      OR position(t.new_text IN p.prosrc) = 0
      OR p.prosrc ~* '(intentalo|abrí la app|confirmá)';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00638: not the patched body, or voseo still there: %', v_bad;
  END IF;
END
$assert$;
