-- 00562_partner_photos_bucket.sql
--
-- Bucket para las fotos de los lugares aliados, que hasta ahora solo se podían
-- cargar pegando una URL a mano. Nadie tiene la foto de una panadería ya alojada
-- en algún lado, así que el panel necesita subirla.
--
-- PÚBLICO, como `delivery-photos` y `dispute-evidence`: la foto se muestra en el
-- carrusel del pasajero y en el panel, y ninguno de los dos está autenticado
-- contra el servicio de Storage.
--
-- SIN policy de SELECT a propósito. Los otros buckets públicos tampoco la
-- tienen: el flag `public` ya hace que se sirvan por el CDN sin pasar por RLS.
-- Agregar una sería ruido que sugiere un control que no está operando ahí.
--
-- SIN policy de INSERT tampoco, y esto sí es una decisión: las escrituras entran
-- EXCLUSIVAMENTE por la Edge Function `storage-upload` con service-role, que
-- autentica al llamador y exige rol admin (rama agregada en el mismo PR). Una
-- policy de INSERT para `authenticated` no serviría igual — el servicio de
-- Storage no valida los JWT ES256 de este proyecto y trata al usuario como
-- `anon` — y solo ampliaría la superficie sin habilitar nada.
--
-- El límite de 5 MB es holgado para lo que el carrusel muestra (~340 px de
-- ancho); el panel además comprime antes de subir.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'partner-photos',
  'partner-photos',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;
