# Progreso del Acompañamiento de Pagos

> Bitácora del proceso de aprobación e integración de procesador de pagos para
> **MACH DIGITAL TECH S.R.L.** (marca: TriciGo). Formato definido en
> `PAYMENT_COMPANION.md` §7. Actualizar al final de cada sesión con cambios
> significativos.

## Estado general

- **Fase actual:** A y C cerradas; **B1 + B4–B7 y D1 hechos en código**; B2/B3 esperan
  la cuenta Sumsub. **D2 (NETOPIA) skeleton en código** — migración `00280` + las dos
  edge functions (`create-netopia-payment-intent`, `process-netopia-webhook`) escritas;
  faltan credenciales sandbox cargadas en Deno env y un dry-run con tarjeta de prueba
  para activar. Migraciones `00273`–`00280` escritas; aplicarlas a producción es paso
  del pipeline de deploy. Próximo: cargar credenciales NETOPIA sandbox + dry-run;
  después D3 (EuPlătesc), E/F/G.
- **Procesador objetivo:** NETOPIA Payments + EuPlătesc, ambos detrás de una capa de
  abstracción `PaymentProvider`. Stripe se retira al final (cuando el reemplazo esté
  verificado en Live). Decidido el 2026-05-18.
- **Modo:** Sandbox — POS sandbox NETOPIA creado y aprobado automáticamente. POS LIVE
  también creado, esperando que se haga `SOLICITĂ APROBARE` y se firme contrato.
- **Última actualización:** 2026-05-20 — Claude (sesión: POS NETOPIA sandbox+live
  creados desde el dashboard, skeleton D2).

## Hitos completados

- **2026-05-17** — Auditoría de aprobación (`AUDIT_PAYMENT_APPROVAL.md`): 21 hallazgos
  (5 🔴 / 10 🟠 / 6 🟡), veredicto **"NECESITA TRABAJO"**.
- **2026-05-17** — Sprint 1 (commit `a92aaac`): TriciCoin closed-loop del lado del
  pasajero — eliminada la transferencia P2P del frontend, saldo en créditos (no USD),
  reencuadre "moneda virtual / wallet / billetera" → "créditos de viaje", cláusula
  closed-loop en Términos, identidad merchant MACH DIGITAL TECH S.R.L. en footer/about/JSON-LD.
- **2026-05-17** — Sprint 2 (commit `40902af`): páginas `/refunds` y `/contact`,
  footer + sitemap, Privacidad GDPR/ANSPDCP, Términos con cláusula AML + PCI-DSS SAQ-A
  + statement descriptor "TRICIGO MOBILITY RO", limpieza de TropiPay,
  `docs/SANCTIONS_SCREENING_PROCEDURE.md`.
- **2026-05-17** — Sprint 3 (commit `515a53b`): emails transaccionales reencuadrados,
  docs ASO reescritos sin la narrativa de ocultamiento, dominio unificado a tricigo.com.
- **2026-05-18** — Eliminación del cashout del conductor (commit `85e0f26`): migración
  `00273`, el TriciCoin del conductor pasa a ser crédito de comisión closed-loop. Ver
  `CASHOUT_REMOVAL_LOG.md`.
- **2026-05-18** — Plan de cierre aprobado (Fases A–G). Re-auditoría: ~16/21 hallazgos
  cerrados; abiertos F-A9 (SDN), F-M1 (ley aplicable), F-A6 (/aml, /cookies).
- **2026-05-18** — **Fase A ejecutada en código:**
  - `BUSINESS_MODEL.md` y `PAYMENT_COMPANION.md` movidos al repo (`docs/payment-processor/`);
    §11 de `BUSINESS_MODEL.md` sincronizado con la realidad del código.
  - Migración `00274_remove_p2p_transfer.sql`: revoca el RPC `transfer_wallet_p2p` y el
    helper `find_user_by_phone` — TriciCoin deja de ser transferible entre usuarios también
    a nivel base de datos.
  - Migración `00275_sync_legal_cms_content.sql`: sincroniza el contenido legal completo
    (Términos + Privacidad, es/en) en `cms_content`, para que las páginas live muestren las
    cláusulas del Sprint 2 y no el placeholder del seed `00156`.
  - Limpieza de TropiPay: eliminadas las edge functions deprecadas `create-tropipay-link`
    y `process-tropipay-webhook`; `README.md` actualizado.
  - Verificado: `turbo run check-types` 4/4 apps OK.
- **2026-05-18** — **Fase B1 ejecutada en código** (velocity controls):
  - Migración `00276_customer_topup_velocity.sql`: 2 límites tunables en `platform_config`
    (`velocity_max_recharges_24h`=3, `velocity_max_amount_usd_30d`=1000) + RPC
    `check_topup_velocity` que los chequea contra `payment_intents` (la tabla `rate_limits`
    no sirve: borra filas a las 2h).
  - `create-stripe-payment-intent`: llama al RPC antes de crear el cargo; responde 429 si
    se supera el límite; recargas corporativas exentas; fail-open si la migración no está
    aplicada (no rompe las recargas).
- **2026-05-18** — **Fase D1 ejecutada en código** (abstracción `PaymentProvider`):
  - Tipos agnósticos en `packages/types/src/payment.ts` (`RechargeIntentRequest`,
    `RechargeIntentResult`, `PaymentProviderConfig`; `PaymentProvider` ampliado a
    netopia/euplatesc).
  - `payment.service.ts`: método genérico `createRechargeIntent` + `getPaymentProviderConfig`
    / `getActivePaymentProvider` / `getEnabledPaymentProviders`; `createStripePaymentIntent`
    y `getStripeConfig` pasan a ser wrappers de compat (comportamiento idéntico).
  - Migración `00277_payment_provider_registry.sql`: registry de proveedores en
    `platform_config` (`active_payment_provider`, flags `_enabled`).
  - `docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md`: el contrato que D2/D3 implementan.
  - El flujo Stripe queda intacto; cambios aditivos.
- **2026-05-18** — **Fase C ejecutada en código** (páginas legales):
  - Nuevas páginas `/aml` (política AML / uso aceptable) y `/cookies` (política de
    cookies) — TSX estático, enlazadas en el footer y el sitemap.
  - `/contact`: teléfono real `+5545998622511`.
  - **C3** ejecutada el 2026-05-18 (migración `00279`): la cláusula de ley aplicable de
    los Términos pasa de "leyes de Cuba" a derecho rumano, con carve-out de protección al
    consumidor (es/en/pt + `cms_content`). La redacción se tomó del memo de preparación;
    la confirma el abogado rumano. El sistema de consentimiento de cookies granular
    (banner con toggles) queda como tarea aparte.
- **2026-05-18** — **Fase B4–B7 ejecutada en código** (controles de compliance):
  - **B4:** 3DS2 forzado (`request_three_d_secure: 'any'`) en cada cobro con tarjeta.
  - **B5:** trigger de auditoría sobre `payment_intents` (migración `00278` §1 — reutiliza
    `record_audit()`).
  - **B6:** device fingerprinting — `payment_intents` guarda IP, user-agent y un
    fingerprint del navegador; el edge function lo escribe con un `UPDATE` fail-open.
  - **B7:** RPC `build_chargeback_evidence` que arma el paquete de evidencia para
    defender un chargeback (recarga + cuenta + viajes que probaron la entrega del
    servicio) + doc `docs/payment-processor/CHARGEBACK_POLICY.md`.
- **2026-05-20** — **POS NETOPIA creados desde el dashboard** (live + sandbox):
  - **LIVE** (`admin.netopia-payments.com`, cuenta MACH DIGITAL TECH S.R.L.): pasos 1-3
    del onboarding (eligibilidad / inscripción / verificación) ya estaban hechos.
    Creado el POS `TriciGo` → `https://tricigo.com` → `Transport pasageri (limuzină
    și taxi)` (MCC 4121, coincide con la declaración del audit). NETOPIA ofrece la
    `Semnătură` del POS: `3E0W-SECV-NYE1-RE28-TKBX`. Faltan: clickear
    `SOLICITĂ APROBARE` (paso 5-6, revisión humana del sitio por NETOPIA) y firmar
    contrato (paso 7) — eso es decisión de Maria/Ale, no se hizo en esta sesión.
  - **SANDBOX** (`sandbox.netopia-payments.com`, cuenta separada del live): POS
    `TriciGo` creado y **aprobado automáticamente** (`Card: Aprobat`). El modal
    `Setări tehnice` ofrece la signature (compartida con LIVE) y dos botones
    DESCARCĂ — clave privada PEM + clave pública PEM. Las claves PEM las descarga
    Eduardo manualmente; van en la carpeta segura `C:\Users\Eduardo\TriciGo\.secrets\netopia\sandbox\`
    (fuera del repo) y se cargan como Edge Function secrets de Supabase
    (`NETOPIA_SANDBOX_PRIVATE_KEY`, `NETOPIA_SANDBOX_PUBLIC_KEY`).
- **2026-05-20** — **Fase D2 (NETOPIA) skeleton en código** (más tarde sustituido
  por la versión sandbox-ready, ver entrada siguiente):
  - Migración `00280_netopia_provider_config.sql`: claves `netopia_*` en
    `platform_config` (environment switch `sandbox`/`live`, signature por entorno,
    límites y fees). Las claves PEM **NO** van en `platform_config` — son
    multi-línea, viven en Deno env. Defaults vacíos.
  - Edge functions `create-netopia-payment-intent` y `process-netopia-webhook`:
    estructura completa pero con `callNetopiaStart` y `verifyNetopiaSignature`
    stubeados — escritas asumiendo el flujo v1.x legacy (RSA-signed bodies).
- **2026-05-20** — **Recarga NETOPIA directa en apps móviles (in-app browser):**
  - Las apps cliente y driver ya no kicean al browser del sistema (`Linking.openURL`)
    para recargar — ahora abren la hosted-payment-page de NETOPIA dentro de un
    in-app browser via `WebBrowser.openAuthSessionAsync` (mismo patrón que el
    OAuth login del monorepo).
  - **Edge function `create-netopia-payment-intent`**: acepta nuevo campo
    opcional `return_url_base` en el body. Lo valida contra prefijos
    permitidos (`https://tricigo.com/`, `tricigo://`, `tricigo-driver://`) y lo
    usa como base del `redirectUrl` que se manda a NETOPIA, appendando
    `?intent=<id>`. Sin el campo, sigue el comportamiento web (default
    `tricigo.com/wallet`). Deploy en prod confirmado (exit 0).
  - **Types** (`packages/types/src/payment.ts`): agregado `returnUrl?: string`
    a `RechargeIntentRequest`.
  - **Service** (`packages/api/src/services/payment.service.ts`):
    `createRechargeIntent` propaga `return_url_base` al body del fetch.
  - **Cliente** (`apps/client/app/(tabs)/wallet.tsx`): `submitRecharge`
    reescrito — llama `createRechargeIntent` con
    `returnUrl='https://tricigo.com/app/client/wallet'`, abre el browser
    in-app con `WebBrowser.openAuthSessionAsync(redirectUrl, dismissUrl)`,
    branch sobre `result.type` (`cancel`/`dismiss` → toast info, `success` →
    poll del intent → success/failed toast). Importado `expo-web-browser`.
    Copy del bottom sheet actualizado: banner ahora dice "Pagás de forma
    segura sin salir de la app", botón "Pagar con tarjeta".
  - **Driver** (`apps/driver/app/wallet/recharge.tsx`): `handleRecharge`
    reescrito con el mismo patrón —
    `returnUrl='https://tricigo.com/app/driver/wallet'`,
    `rechargeType='driver_quota'`. Usa `useAuthStore` para el userId.
  - **Bridge pages en web** (nuevas):
    - `apps/web/src/app/app/client/wallet/page.tsx`
    - `apps/web/src/app/app/driver/wallet/page.tsx`
    Si el universal link no abre la app (desktop, o instalación sin
    associated domains verificados), estas páginas ofrecen "Abrir en TriciGo"
    (deep link al custom scheme `tricigo://` o `tricigo-driver://`) o
    "Continuar en el navegador" (redirige a `/wallet?intent=<id>` — la web
    wallet). Desktop redirige directo a la wallet web.
  - **Whitelist de prefijos válidos para return URL** (defensa contra
    open-redirect): solo `https://tricigo.com/`, `tricigo://`,
    `tricigo-driver://`. Cualquier otro prefijo → 400 `invalid_return_url`.
  - `turbo check-types`: 4/4 OK.
  - **Fallback documentado a custom scheme**: si el dry-run muestra que
    iOS/Android no abre la app via universal link
    (apple-app-site-association/assetlinks no servidos), cambiar la constante
    `RETURN_URL_BASE` en `wallet.tsx` / `recharge.tsx` a `tricigo://wallet` /
    `tricigo-driver://wallet`, y agregar el handler correspondiente en
    `useDeepLinkHandler.ts` / `useAuthDeepLink.ts`.
- **2026-05-20** — **Stripe cutover completo: NETOPIA es el único proveedor** (Eduardo
  autorizó la opción B en chat):
  - Migración `00281_remove_stripe_promote_netopia.sql`: borra todas las filas
    `stripe_*` de `platform_config` excepto el flag, pone
    `active_payment_provider = "netopia"`, `netopia_enabled = true`,
    `stripe_enabled = false`. Aplicado ya a producción vía MCP (Eduardo
    autorizó explícitamente).
  - Tipos (`packages/types/src/payment.ts`): eliminados
    `CreateStripeIntentResponse` y `StripeRechargeConfig`. `PaymentProvider`
    sigue listando `stripe`/`tropipay` como legacy para que las filas
    históricas de `payment_intents` sigan tipando, pero ningún code path nuevo
    los crea.
  - Service (`packages/api/src/services/payment.service.ts`): eliminados los
    wrappers `createStripePaymentIntent` y `getStripeConfig`. `KNOWN_PROVIDERS`
    ahora es `['netopia', 'euplatesc']`. `getActivePaymentProvider` default
    pasa a `'netopia'`.
  - UI web (`apps/web/src/app/wallet/page.tsx`): reescrita — sin Stripe
    Elements, sin `loadStripe`. Flujo NETOPIA redirect: monto → click →
    `createRechargeIntent` → `window.location.href = redirectUrl`. Vuelta desde
    NETOPIA con `?intent=<id>` activa polling de status.
  - UI cliente móvil (`apps/client/app/(tabs)/wallet.tsx`): eliminado el flujo
    nativo de `@stripe/stripe-react-native` PaymentSheet. La pantalla de
    recarga ahora siempre abre `https://tricigo.com/wallet` con
    `Linking.openURL` (el flow NETOPIA redirect vive en la web). Eliminadas
    las refs a `stripeConfig`/`stripeReady`/`useStripe`.
  - `apps/client/src/lib/stripe-bootstrap.tsx`: convertido en pass-through
    (no-op) para mantener compat con `_layout.tsx`; cleanup completo en PR
    futuro.
  - Edge functions del repo eliminadas: `supabase/functions/create-stripe-payment-intent/`
    y `supabase/functions/process-stripe-webhook/`.
  - Edge functions deployadas eliminadas vía CLI:
    `npx supabase functions delete create-stripe-payment-intent` y
    `... delete process-stripe-webhook`.
  - Secret store de Supabase: 0 `STRIPE_*`, 3 `NETOPIA_*` (`API_KEY`,
    `PRIVATE_KEY`, `PUBLIC_KEY`).
  - `turbo check-types`: 4/4 OK (full re-run, no cache).
  - **NO incluido** (deferido a PR de cleanup): drop del RPC
    `process_stripe_recharge` (NETOPIA lo sigue invocando hasta el rename a
    `process_recharge_payment`); las apps admin/driver mantienen pantallas
    que muestran data histórica con `payment_provider='stripe'` — eso es
    consultable, no break el flow.
- **2026-05-20** — **Fase D2 NETOPIA — sandbox-ready** (reemplaza stubs con código
  real v2.x):
  - Descubrimiento clave leyendo `https://doc.netopia-payments.com/docs/payment-api/v2.x/intro`
    y la OpenAPI en `https://secure.sandbox.netopia-payments.com/spec`: la API
    activa es **v2.x** y usa autenticación por **API KEY** en el header
    `Authorization` (raw, sin Bearer). Las claves PEM que descargamos son para la
    v1.x legacy y **no se usan en v2.x** — quedan archivadas en
    `.secrets/netopia/sandbox/` por si la migración futura las requiere, pero el
    flujo activo no las consume.
  - **API KEY generado** en `sandbox.netopia-payments.com/security` (botón
    "Generează cheie", denumire `tricigo-d2-sandbox`) y cargado como Edge Function
    secret `NETOPIA_SANDBOX_API_KEY`. La signature del POS
    (`3E0W-SECV-NYE1-RE28-TKBX`) sigue en `platform_config.netopia_sandbox_signature`
    y se envía en `order.posSignature` del body.
  - `create-netopia-payment-intent` reescrito: hace `POST` real a
    `https://secure.sandbox.netopia-payments.com/payment/card/start` con
    `Authorization: <api-key>` y el body `{ config, payment, order }` del spec
    (incluye `billing` completo con país Rumanía 642 como default para usuarios
    diaspora; Cuba sigue bloqueada arriba por el chequeo OFAC). Devuelve
    `redirectUrl` (paymentURL hosted de NETOPIA) y `netopiaNtpId`.
  - `process-netopia-webhook` reescrito: parsea el shape real del IPN (status
    3/5=paid, 12=failed, 15=3DS-pending), valida que `order.orderID` es un UUID v4
    existente en `payment_intents` con `payment_provider='netopia'` (defensa
    UUID-secret: NETOPIA no documenta firma HMAC del IPN), hace claim atómico,
    llama `process_stripe_recharge` para acreditar la wallet, y responde el ACK
    requerido `{ code: "0", message: "OK" }`.
  - Tarjetas sandbox listas para dry-run: `9900004810225098` (no 3DS),
    `9900009184214768` (con 3DS), CVV `111`, exp futura cualquiera.
  - **Falta para el dry-run**: deploy de las dos edge functions a Supabase
    (`npx supabase functions deploy create-netopia-payment-intent --project-ref ...`
    y la del webhook) y prender `netopia_enabled=true` justo antes de testear.

## Bloqueos activos

- **Revisión legal OFAC / sanciones** — la gestiona Eduardo por separado; es acción suya.
  Bloquea la Fase F (aplicación al procesador). Claude NO puede emitir esta opinión
  (`PAYMENT_COMPANION.md` §9).
- **Migraciones SQL sin aplicar a producción** (guard de MCP) — `00273` (cashout),
  `00274` (P2P), `00275` (contenido legal CMS), `00276` (velocity controls), `00277`
  (registry de proveedores), `00278` (controles de compliance B5/B6/B7), `00279` (ley
  aplicable) y `00280` (config NETOPIA) quedan escritas en el repo; aplicarlas es paso
  del pipeline de deploy. Hasta entonces: el closed-loop es real en el frontend pero no
  en el backend, las páginas legales live siguen mostrando el placeholder viejo, el
  velocity control y el audit trail de pagos no se activan, y la edge function es
  fail-open en los controles que dependen de SQL aún no aplicado.
- **Credenciales NETOPIA sandbox sin cargar en Deno env** — la signature va en
  `platform_config.netopia_sandbox_signature` (placeholder vacío en la migración
  `00280`); las claves PEM van en Edge Function secrets
  (`NETOPIA_SANDBOX_PRIVATE_KEY`, `NETOPIA_SANDBOX_PUBLIC_KEY`). Hasta que Eduardo las
  cargue, la edge function devuelve `503 not_configured`.
- **`callNetopiaStart` y `verifyNetopiaSignature` siguen siendo stubs** — sin un
  dry-run sandbox con una tarjeta de prueba no se puede confirmar el shape exacto de la
  request (`POST /payment/card/start`) ni el formato de la IPN (signature header name,
  body JSON vs envelope encriptado). Ambas funciones están marcadas con `TODO(D2)`.

## Decisiones pendientes del fundador

(Ninguna decisión de proveedor pendiente.)

Resueltas el 2026-05-18: reemplazar Stripe por procesadores rumanos; integrar NETOPIA +
EuPlătesc en paralelo detrás de una abstracción; la revisión legal la gestiona Eduardo;
**proveedor de KYC y de SDN screening: Sumsub para ambos** (Fases B2 y B3 — un solo vendor).

## Acciones pendientes de Eduardo (destraban trabajo de Claude)

- **Descargar las claves PEM sandbox de NETOPIA** desde `sandbox.netopia-payments.com` →
  Puncte de vânzare → menú 3 puntos del POS TriciGo → `Setări tehnice` → DESCARCĂ
  privada + DESCARCĂ pública. Guardarlas en
  `C:\Users\Eduardo\TriciGo\.secrets\netopia\sandbox\` (fuera del repo). Cargar el
  contenido como Edge Function secrets en Supabase
  (`NETOPIA_SANDBOX_PRIVATE_KEY`, `NETOPIA_SANDBOX_PUBLIC_KEY`) y la `Semnătură` del
  POS en `platform_config.netopia_sandbox_signature`. Destraba el dry-run de D2.
- **Crear cuenta en Sumsub** (sumsub.com) y obtener las API keys de Sandbox — destraba la
  implementación de B2 (KYC del pagador) y B3 (SDN screening de conductores).
- **Contacto comercial + contrato con EuPlătesc** — destraba la integración D3b.
- **Contratar las opiniones legales reales** — un abogado rumano de fintech (BNR/MiCA —
  el "gate crítico" antes de aplicar al procesador) y un especialista en sanciones OFAC.
  El memo de preparación (`TriciGo_Memorandum_Legal_OFAC_BNR.docx` — una simulación, NO
  una opinión legal válida) sirve como brief para entregarles. Bloquea la Fase F.

## Acciones pendientes de Maria/Ale (no Eduardo)

- **Clickear `SOLICITĂ APROBARE` en el POS LIVE** (`admin.netopia-payments.com` →
  Configurare cont → paso 5-6) cuando D2 esté verificado en sandbox. Dispara la
  revisión humana del sitio por NETOPIA.
- **Firmar el contrato de colaboración con NETOPIA** (paso 7). Después de eso,
  NETOPIA emite las claves LIVE que reemplazan las sandbox.

## Próximas 3 acciones recomendadas

1. **Cargar credenciales NETOPIA sandbox** (signature + claves PEM como Edge secrets) y
   correr un dry-run con una tarjeta de prueba para confirmar el shape de la API y de
   la IPN — eso destraba reemplazar los stubs `callNetopiaStart` y
   `verifyNetopiaSignature` con código real.
2. **Fase D3 (EuPlătesc)** — repetir el patrón D2 contra el contrato D1; espera que la
   empresa firme contrato con EuPlătesc.
3. **Fase B2/B3** — KYC del pagador y SDN screening con Sumsub; esperan que Eduardo
   cree la cuenta Sumsub.

## Notas de ubicación de documentos

- `BUSINESS_MODEL.md` y `PAYMENT_COMPANION.md` ya están versionados en el repo, en
  `docs/payment-processor/` (movidos desde `Downloads\` el 2026-05-18).
- `tricigo_roadmap_procesador.md` (citado en `PAYMENT_COMPANION.md` §2 como fuente de
  verdad #2) no existe ni en el repo ni en Downloads. El plan de fases vive en el plan
  aprobado y en este archivo.
