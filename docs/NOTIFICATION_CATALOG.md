# Catálogo de notificaciones push — TriciGo

> Estado: 2026-06-04. Auditado contra prod (Fase 5 del plan de notificaciones de contenido).

Toda push pasa por la Edge Function **`send-push`**, que: valida el `category` contra `VALID_CATEGORIES`, busca los tokens del usuario en `user_devices`, postea a la Expo Push API (`priority:'high'`, `channelId:'rides'`) y persiste una fila en el inbox `notifications` (`type = category`). El ícono visible en la barra es el de **cada app** (`apps/<app>/assets/notification-icon.png`); el título es el que arma el emisor.

## Quién dispara cada categoría

| `category` | Emisor (trigger / EF / admin) | Evento | Audiencia | Navegación al tocar |
|---|---|---|---|---|
| `ride` | `notify_ride_status_change`, `notify_rider_gps_override_request`, `activate_scheduled_rides` | cambios de estado del viaje, confirmar GPS, viaje programado activado | customer / driver | home `/(tabs)` |
| `ride_offer` | `notify_driver_new_offer` | nueva oferta de viaje | driver | home `/(tabs)` |
| `ride_matching` | `notify_dispatch_retry` | reintento de despacho (rondas 2/3) | customer | home `/(tabs)` |
| `proximity` | `check_proximity_notification` *(escribe `ride_updates`, legacy)* | conductor cerca del pickup/dropoff | customer / driver | home `/(tabs)` |
| `chat` | `notify_new_chat_message` | nuevo mensaje en el viaje | customer / driver | `/chat/{ride_id}` (driver: `/trip`) |
| `payment` | `notify_payment_intent_failure` | recarga fallida | customer | wallet |
| `wallet_recharge` / `wallet_recharge_refund` | webhook NETOPIA (`process-netopia-webhook`) | resultado de recarga / reembolso | customer | wallet / earnings |
| `lost_item` | `notify_lost_item_change` *(category `system`)* | objeto perdido (reportado/encontrado/devuelto) | driver + rider | — |
| `scheduled_ride` | `activate_scheduled_rides` *(category `ride`)* | viaje programado activado | driver | home `/(tabs)` |
| **`announcement`** | admin **Novedades** (botón "Notificar ahora" + notificar-al-publicar) | nueva novedad/anuncio | **ambos** (todos los activos) | home `/(tabs)` |
| **`blog`** | admin **Blog** | post publicado | **ambos** | home `/(tabs)` |
| **`promo`** | admin **Promociones** | promo activada | **ambos** | home `/(tabs)` |
| `campaign` | admin **Campañas** (segmentado) | campaña de marketing | segmento elegido | home `/(tabs)` |
| `system` | fallback + broadcast manual (`/notifications`) + `admin_send_wallet_v2_bonus_push` | varios | varía | home `/(tabs)` |
| `wallet_v2_migration` | one-shot 00245 (legacy) | bono de migración de wallet | drivers | — |

**Audiencia "ambos"** (announcement/blog/promo/campaign): `broadcastToActiveUsers` resuelve `get_active_push_user_ids(30)` = todos los usuarios activos (rider + driver), y `send-push` manda a **todos** los tokens de cada usuario → llega a la app del cliente con su ícono y a la del conductor con el suyo.

## No son push (otros canales)

| Emisor | Canal | A quién |
|---|---|---|
| `broadcast-emergency` | SMS | contactos de confianza (SOS) |
| `notify_trusted_contacts_on_*` (00035/00165) | SMS | contactos de confianza |
| `notify_delivery_recipient_on_accept` (00327) | SMS | receptor del paquete |
| `send_ride_receipt_email` (00134) | email | customer |

## Categorías válidas

`send-push` `VALID_CATEGORIES` y el `CHECK` `notifications_type_check` (mig 00333 + 00380) deben quedar **en sync**. Hoy: `ride, ride_offer, ride_matching, chat, proximity, payment, wallet_recharge, wallet_recharge_refund, wallet_credit, wallet_debit, scheduled_ride, lost_item, dispute_update, sos, delivery, system, promo, announcement, blog, news, campaign` + legacy `ride_updates, wallet_v2_migration`.

**Al agregar una categoría nueva:** (1) agregarla a `VALID_CATEGORIES` en `supabase/functions/send-push/index.ts`, (2) extender el `CHECK` vía migración, (3) mapear navegación + `PREF_KEYS` en `apps/{client,driver}/src/hooks/useNotifications.ts`, (4) agregar ícono en el `ICON_MAP` del inbox de ambas apps.

## Deuda conocida (cosmética, no afecta entrega)

- `check_proximity_notification` escribe `ride_updates` (legacy) en vez de `proximity` → en el inbox cae al ícono fallback y no respeta el toggle de "viajes". Consolidar a `proximity` en un follow-up (requiere `CREATE OR REPLACE` de esa función, copiando el cuerpo vivo).
- `lost_item` / `scheduled_ride` escriben con category `system` / `ride` respectivamente (heredado); funcionan, pero el inbox no los discrimina.

## Cómo verificar que una categoría entrega

```sql
-- Smoke directo a send-push (service key resuelto en la query, nunca expuesto):
SELECT net.http_post(
  url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer '||get_service_role_key(), 'apikey', get_service_role_key()),
  body := jsonb_build_object('user_id','<uuid>','title','t','body','b','category','<cat>')
) AS request_id;
-- luego: SELECT status_code, content FROM net._http_response WHERE id=<request_id>;
-- esperado: 200 {"sent":N,"failed":0}
```
