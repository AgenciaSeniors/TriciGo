-- ============================================================
-- 00682 — Support WhatsApp numbers as a platform_config key
--
-- The help screens of the rider app, the driver app and the web opened one
-- number written in the code (+5356621636), so changing it took a new build,
-- and support now answers on two numbers. From this version they read
-- `support_whatsapp_phones` (supportService.getWhatsAppPhones /
-- useSupportPhones): an ordered, comma-separated list. The one-tap buttons
-- ("Pedir ayuda", WhatsApp in Soporte, the driver's support button) open the
-- first number (primarySupportPhone); the help screens list them all.
--
-- When the key is missing, empty or not a list of phones, the apps use the
-- same two numbers built into @tricigo/utils (SUPPORT_WHATSAPP_PHONES). A
-- super_admin edits the list in Settings → Platform config; the panel refuses
-- a value the apps could not open and stores it as "+<digits>, +<digits>".
--
-- The name does not end in _token/_secret/_signature/_hash/_api_key/_password,
-- so platform_config_is_secret (00517) keeps it readable with the publishable
-- key, which is how the apps and the public web page read it.
--
-- ON CONFLICT DO NOTHING keeps a value set by hand.
-- ============================================================

INSERT INTO public.platform_config (key, value)
VALUES ('support_whatsapp_phones', to_jsonb('+5355159376, +5354269290'::text))
ON CONFLICT (key) DO NOTHING;
