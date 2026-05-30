-- ============================================================
-- Fix stale contact email in the seeded CMS "privacy" content.
--
-- The 00156 seed (00156_seed_cms_terms_privacy.sql) put
-- "privacy@tricigo.com" in the privacy CONTACT section (body_es + body_en),
-- but that mailbox does not exist. The canonical support address is
-- soporte@tricigo.com.
--
-- Production was already corrected on 2026-05-30 via an authorized admin
-- update that replaced the short seed draft with the full professional
-- content (which uses soporte@tricigo.com everywhere). This migration makes
-- fresh / rebuilt databases consistent: it runs after the 00156 seed and
-- rewrites the placeholder email. It is a NO-OP on current production, where
-- the privacy content no longer contains "privacy@tricigo.com".
-- ============================================================

UPDATE cms_content
SET body_es = replace(body_es, 'privacy@tricigo.com', 'soporte@tricigo.com'),
    body_en = replace(body_en, 'privacy@tricigo.com', 'soporte@tricigo.com')
WHERE slug = 'privacy'
  AND (body_es LIKE '%privacy@tricigo.com%' OR body_en LIKE '%privacy@tricigo.com%');
