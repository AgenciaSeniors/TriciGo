# Progreso del Acompañamiento de Pagos

> Bitácora del proceso de aprobación e integración de procesador de pagos para
> **MACH DIGITAL TECH S.R.L.** (marca: TriciGo). Formato definido en
> `PAYMENT_COMPANION.md` §7. Actualizar al final de cada sesión con cambios
> significativos.

## Estado general

- **Fase actual:** A (limpieza del modelo) — **completada en código**. Las migraciones
  `00273` / `00274` / `00275` quedan escritas; aplicarlas a producción es paso del
  pipeline de deploy. Próximo: Fases B, C y D.
- **Procesador objetivo:** NETOPIA Payments + EuPlătesc, ambos detrás de una capa de
  abstracción `PaymentProvider`. Stripe se retira al final (cuando el reemplazo esté
  verificado en Live). Decidido el 2026-05-18.
- **Modo:** Pre-Sandbox — todavía sin integración de procesador rumano.
- **Última actualización:** 2026-05-18 — Claude (sesión: plan de cierre + ejecución Fase A).

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

## Bloqueos activos

- **Revisión legal OFAC / sanciones** — la gestiona Eduardo por separado; es acción suya.
  Bloquea la Fase F (aplicación al procesador). Claude NO puede emitir esta opinión
  (`PAYMENT_COMPANION.md` §9).
- **Migraciones SQL sin aplicar a producción** (guard de MCP) — `00273` (cashout),
  `00274` (P2P) y `00275` (contenido legal CMS) quedan escritas en el repo; aplicarlas es
  paso del pipeline de deploy. Hasta entonces: el closed-loop es real en el frontend pero
  no en el backend, y las páginas legales live siguen mostrando el placeholder viejo.

## Decisiones pendientes del fundador

- **Proveedor de KYC del pagador** (Fase B2) — Sumsub / Veriff / Onfido.
- **Proveedor de SDN screening** (Fase B3) — ComplyAdvantage / Sanctions.io.

(Resueltas el 2026-05-18: reemplazar Stripe por procesadores rumanos; integrar NETOPIA +
EuPlătesc en paralelo detrás de una abstracción; la revisión legal la gestiona Eduardo.)

## Próximas 3 acciones recomendadas

1. **Fase C** (rápida, sin dependencia externa): crear las páginas `/aml` y `/cookies`;
   pedir a Eduardo el teléfono real para `/contact`.
2. **Fase B1** (sin dependencia de proveedor): velocity controls por usuario en backend
   Supabase (máx. cargos/24h, máx. monto/30 días).
3. **Fase B2/B3**: decidir proveedores de KYC y SDN screening para destrabar esas tareas;
   en paralelo, **Fase D1**: construir la abstracción `PaymentProvider`.

## Notas de ubicación de documentos

- `BUSINESS_MODEL.md` y `PAYMENT_COMPANION.md` ya están versionados en el repo, en
  `docs/payment-processor/` (movidos desde `Downloads\` el 2026-05-18).
- `tricigo_roadmap_procesador.md` (citado en `PAYMENT_COMPANION.md` §2 como fuente de
  verdad #2) no existe ni en el repo ni en Downloads. El plan de fases vive en el plan
  aprobado y en este archivo.
