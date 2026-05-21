-- ============================================================
-- Migration 00279: Terms governing-law clause -> Romanian law
--
-- Phase C3. The Terms & Conditions stated they were governed by the
-- "laws of the Republic of Cuba" — incoherent for MACH DIGITAL TECH
-- S.R.L. (a Romanian company) and a documented underwriting risk
-- (audit finding F-M1). This swaps the governing-law clause for
-- Romanian law, with a consumer-protection carve-out.
--
-- The clause text mirrors the i18n bundle (terms.governing_law_text
-- in es/en/pt web.json). It follows the wording recommended by a
-- preparation memo; the FINAL wording should still be confirmed by
-- the Romanian lawyer engaged for the BNR/MiCA opinion.
--
-- Surgical replace() — only the governing-law sentence changes. Runs
-- after 00275 (which seeds the full cms_content terms body). If the
-- old sentence is not found, replace() is a harmless no-op.
-- ============================================================

UPDATE cms_content
SET
  body_es = replace(
    body_es,
    $old_es$Estos términos se rigen por las leyes de la República de Cuba. Cualquier disputa será resuelta en los tribunales competentes de La Habana, Cuba.$old_es$,
    $new_es$Los presentes Términos y Condiciones se rigen e interpretan de conformidad con el derecho rumano. Cualquier disputa derivada del uso de la plataforma TriciGo se someterá a los tribunales competentes de Brașov, Rumanía, sin perjuicio del derecho del usuario consumidor a acudir a los tribunales del lugar de su domicilio habitual conforme a la normativa de protección al consumidor aplicable. Estos términos no afectan los derechos irrenunciables que correspondan al usuario según la legislación de su país de residencia.$new_es$
  ),
  body_en = replace(
    body_en,
    $old_en$These terms are governed by the laws of the Republic of Cuba. Any dispute shall be resolved in the competent courts of Havana, Cuba.$old_en$,
    $new_en$These Terms and Conditions are governed by and construed in accordance with Romanian law. Any dispute arising from the use of the TriciGo platform shall be submitted to the competent courts of Brașov, Romania, without prejudice to a consumer user's right to bring proceedings before the courts of their place of habitual residence under applicable consumer-protection law. These terms do not affect the mandatory rights granted to the user under the law of their country of residence.$new_en$
  ),
  updated_at = NOW()
WHERE slug = 'terms';
