# Progreso del Acompañamiento de Pagos

> Bitácora del proceso de aprobación e integración de procesador de pagos para
> **MACH DIGITAL TECH S.R.L.** (marca: TriciGo). Formato definido en
> `PAYMENT_COMPANION.md` §7. Actualizar al final de cada sesión con cambios
> significativos.

## Estado general

- **Fase actual:** B (controles de compliance) en curso — **B1 (velocity controls) hecho
  en código**. Migraciones `00273`–`00276` escritas; aplicarlas a producción es paso del
  pipeline de deploy. Próximo: B2/B3 (KYC + SDN, esperan cuenta Sumsub), Fase C, D1.
- **Procesador objetivo:** NETOPIA Payments + EuPlătesc, ambos detrás de una capa de
  abstracción `PaymentProvider`. Stripe se retira al final (cuando el reemplazo esté
  verificado en Live). Decidido el 2026-05-18.
- **Modo:** Pre-Sandbox — todavía sin integración de procesador rumano.
- **Última actualización:** 2026-05-18 — Claude (sesión: plan de cierre, Fase A, Fase B1).

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

## Bloqueos activos

- **Revisión legal OFAC / sanciones** — la gestiona Eduardo por separado; es acción suya.
  Bloquea la Fase F (aplicación al procesador). Claude NO puede emitir esta opinión
  (`PAYMENT_COMPANION.md` §9).
- **Migraciones SQL sin aplicar a producción** (guard de MCP) — `00273` (cashout),
  `00274` (P2P), `00275` (contenido legal CMS) y `00276` (velocity controls) quedan
  escritas en el repo; aplicarlas es paso del pipeline de deploy. Hasta entonces: el
  closed-loop es real en el frontend pero no en el backend, las páginas legales live
  siguen mostrando el placeholder viejo, y el velocity control no se activa (la edge
  function es fail-open mientras el RPC `check_topup_velocity` no exista).

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
- **Teléfono real para la página `/contact`** — destraba la tarea C4.

## Próximas 3 acciones recomendadas

1. **Fase C** (rápida, sin dependencia externa): crear las páginas `/aml` y `/cookies`.
2. **Fase D1** (sin dependencia externa): construir la abstracción `PaymentProvider`
   sobre la cual se integrarán NETOPIA y EuPlătesc.
3. **Fase B4–B7** (3DS2 explícito, audit trail de pagos, device fingerprinting, política
   de chargebacks). B2/B3 esperan la cuenta Sumsub de Eduardo.

## Notas de ubicación de documentos

- `BUSINESS_MODEL.md` y `PAYMENT_COMPANION.md` ya están versionados en el repo, en
  `docs/payment-processor/` (movidos desde `Downloads\` el 2026-05-18).
- `tricigo_roadmap_procesador.md` (citado en `PAYMENT_COMPANION.md` §2 como fuente de
  verdad #2) no existe ni en el repo ni en Downloads. El plan de fases vive en el plan
  aprobado y en este archivo.
