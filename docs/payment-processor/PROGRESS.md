# Progreso del Acompañamiento de Pagos

> Bitácora del proceso de aprobación e integración de procesador de pagos para
> **MACH DIGITAL TECH S.R.L.** (marca: TriciGo). Formato definido en
> `PAYMENT_COMPANION.md` §7. Actualizar al final de cada sesión con cambios
> significativos.

## Estado general

- **Fase actual:** A y C cerradas; **B1 + B4–B7 y D1 hechos en código**; B2/B3 esperan
  la cuenta Sumsub. Migraciones `00273`–`00278` escritas; aplicarlas a producción es
  paso del pipeline de deploy. Próximo: D2/D3 (NETOPIA / EuPlătesc), después E/F/G.
- **Procesador objetivo:** NETOPIA Payments + EuPlătesc, ambos detrás de una capa de
  abstracción `PaymentProvider`. Stripe se retira al final (cuando el reemplazo esté
  verificado en Live). Decidido el 2026-05-18.
- **Modo:** Pre-Sandbox — todavía sin integración de procesador rumano.
- **Última actualización:** 2026-05-18 — Claude (sesión: plan de cierre, Fase A, B1, D1, C, B4–B7).

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

## Bloqueos activos

- **Revisión legal OFAC / sanciones** — la gestiona Eduardo por separado; es acción suya.
  Bloquea la Fase F (aplicación al procesador). Claude NO puede emitir esta opinión
  (`PAYMENT_COMPANION.md` §9).
- **Migraciones SQL sin aplicar a producción** (guard de MCP) — `00273` (cashout),
  `00274` (P2P), `00275` (contenido legal CMS), `00276` (velocity controls), `00277`
  (registry de proveedores) y `00278` (controles de compliance B5/B6/B7) quedan escritas
  en el repo; aplicarlas es paso del pipeline de deploy. Hasta entonces: el closed-loop
  es real en el frontend pero no en el backend, las páginas legales live siguen mostrando
  el placeholder viejo, el velocity control y el audit trail de pagos no se activan, y la
  edge function es fail-open en los controles que dependen de SQL aún no aplicado.

## Decisiones pendientes del fundador

(Ninguna decisión de proveedor pendiente.)

Resueltas el 2026-05-18: reemplazar Stripe por procesadores rumanos; integrar NETOPIA +
EuPlătesc en paralelo detrás de una abstracción; la revisión legal la gestiona Eduardo;
**proveedor de KYC y de SDN screening: Sumsub para ambos** (Fases B2 y B3 — un solo vendor).

## Acciones pendientes de Eduardo (destraban trabajo de Claude)

- **Crear cuenta en Sumsub** (sumsub.com) y obtener las API keys de Sandbox — destraba la
  implementación de B2 (KYC del pagador) y B3 (SDN screening de conductores).
- **Crear cuenta Sandbox en NETOPIA** — destraba la integración D2b.
- **Contacto comercial + contrato con EuPlătesc** — destraba la integración D3b.
- **Contratar las opiniones legales reales** — un abogado rumano de fintech (BNR/MiCA —
  el "gate crítico" antes de aplicar al procesador) y un especialista en sanciones OFAC.
  El memo de preparación (`TriciGo_Memorandum_Legal_OFAC_BNR.docx` — una simulación, NO
  una opinión legal válida) sirve como brief para entregarles. Bloquea la Fase F.

## Próximas 3 acciones recomendadas

1. **Fase D2/D3** — integrar NETOPIA y EuPlătesc contra el contrato de D1
   (`PAYMENT_PROVIDER_CONTRACT.md`); esperan que Eduardo cree la cuenta Sandbox de
   NETOPIA y el contacto/contrato con EuPlătesc.
2. **Fase B2/B3** — KYC del pagador y SDN screening con Sumsub; esperan que Eduardo
   cree la cuenta Sumsub.
3. **Fases E/F/G** — documentación de underwriting, aplicación al procesador y
   go-live; dependen de que las Fases B y D estén completas.

## Notas de ubicación de documentos

- `BUSINESS_MODEL.md` y `PAYMENT_COMPANION.md` ya están versionados en el repo, en
  `docs/payment-processor/` (movidos desde `Downloads\` el 2026-05-18).
- `tricigo_roadmap_procesador.md` (citado en `PAYMENT_COMPANION.md` §2 como fuente de
  verdad #2) no existe ni en el repo ni en Downloads. El plan de fases vive en el plan
  aprobado y en este archivo.
