# Plan de Remediación — Compliance de Pasarela de Pago · TriciGo

> Documento complementario de `AUDIT_PAYMENT_APPROVAL.md`. Define **cómo** cerrar los 21 hallazgos.
> **Estado: PROPUESTA — ningún cambio de código aplicado.** Requiere tu revisión y aprobación antes de implementar.
> Fecha: 2026-05-17 · Entidad: TriciGo SRL (Rumanía) · Procesadores objetivo: NETOPIA Payments / EuPlătesc.

---

## 0. Decisiones tomadas (base de este plan)

| Tema | Decisión |
|------|----------|
| Naturaleza de TriciCoin | **Closed-loop real.** Se elimina la transferencia P2P entre usuarios y el cash-out a demanda. TriciCoin solo paga viajes propios. Sin licencia EMI. |
| Entidad merchant | **MACH DIGITAL TECH S.R.L.** (Rumanía) — confirmada por contrato del 13/05/2026. "TriciGo" es la marca del producto, no la entidad. Datos parcialmente confirmados (ver §1). |
| Esta sesión | Solo el plan. No se toca código. |
| Asesoría legal | No hay por ahora → los puntos que requieren validación profesional van marcados **[REVISIÓN LEGAL]**. |

---

## 1. Estado de los datos del merchant

**Estructura confirmada (contrato de desarrollo del 13/05/2026):** la entidad merchant es **MACH DIGITAL TECH S.R.L.** (Rumanía). **"TriciGo" es la marca/producto, no la entidad** — el sitio debe presentar TriciGo como un servicio *operado por* MACH DIGITAL TECH S.R.L.

### 1.A · Datos confirmados

| Dato | Valor |
|------|-------|
| Razón social | **MACH DIGITAL TECH S.R.L.** |
| CUI (Cod Unic de Înregistrare) | **54552055** |
| Nr. Reg. Comerțului | **J2026027319006** (registrada en 2026 — empresa nueva) |
| Domicilio social | Jud. Brașov, Municipiul Brașov, Str. Lungă nr. 149, Ap. P3, Rumanía |
| Administradora / repr. legal | Maria Loraime Gonzalez Carvajal Hernandez |
| Email de soporte | **soporte@tricigo.com** |
| Dominio canónico | **tricigo.com** (las fichas de tienda usan `tricigo.app` — son las que se corrigen; ver Paso 3.5) |
| IBAN / SWIFT (ING Rumanía) | RO14INGB0000999919794285 / INGBROBUXXX — **cuenta de liquidación: va en el formulario del procesador, NO en el sitio web** |

### 1.B · Datos pendientes (necesarios para completar los Pasos 1.5, 2.1, 2.2, 2.3, 2.5)

| # | Dato | Uso |
|---|------|-----|
| 1 | **EUID** — probablemente `ROONRC.J2026027319006`; confirmar en el certificado de registro | Footer, /about |
| 2 | **Teléfono de contacto público** | Página /contact (Paso 2.3) |
| 3 | **Statement descriptor** a configurar con NETOPIA/EuPlătesc (sugerido `TRICIGO MOBILITY RO`) | Paso 2.1 |
| 4 | **Parámetros de reembolso** (ventana de cancelación sin cargo, plazo de devolución de saldo no consumido) | Paso 2.2 |
| 5 | **Responsable de protección de datos / email de privacidad** | Paso 2.5 |

> **Verificación:** confirmá que el titular de la cuenta bancaria figure **exactamente** como "MACH DIGITAL TECH S.R.L." (la jefa envió "MACH TECH S.R.L"; el nombre legal válido es el del contrato y del RegCom).

---

## 2. Aclaraciones de alcance

1. **Frontend-only.** Este plan remedia el *contenido* del frontend. La integración técnica del SDK de NETOPIA/EuPlătesc (hoy el código usa Stripe) es un proyecto de ingeniería **aparte**, fuera de este plan.
2. **Términos y Privacidad se sirven desde un CMS.** `terms/page.tsx` y `privacy/page.tsx` cargan el contenido vía `cmsService.getContent(...)` desde la tabla `cms_content`; el i18n es solo *fallback*. Editar el i18n **no** cambia lo que ve el usuario hasta que se actualice el CMS. Cada paso sobre textos legales tiene un sub-ítem **[CMS]**.
3. **3 ítems requieren cambios de BACKEND**, fuera del alcance frontend de este plan pero **obligatorios** para que la afirmación closed-loop sea verdadera. Van marcados **[BACKEND]**. Quitar solo la UI no basta: si el RPC sigue vivo, la capacidad existe y la declaración ante el procesador sería inexacta.
4. Dependencia clave: **el Paso 1.3 (reencuadre de copy) solo es válido después del Paso 1.1 (cambio de producto).** Renombrar antes de quitar la transferencia P2P haría el copy inexacto en sentido inverso.

---

## 3. Sprint 1 — Bloqueantes (antes de aplicar a NETOPIA/EuPlătesc)

### Paso 1.1 — TriciCoin closed-loop: eliminar la transferencia P2P entre usuarios
**Cierra:** F-C2, F-A2 (parcial) · **Tipo:** Producto/UI

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `apps/web/src/app/wallet/page.tsx` | Eliminar la sección "Enviar TriciCoin" (l.646-728), el estado de transferencia (l.220-228), `handleFindRecipient` (l.411-428) y `handleTransfer` (l.430-463). Quitar las pestañas de filtro `received`/`sent` de `FILTER_TABS` (l.31-32), del tipo `FilterTab` y de `getFilterTypes`. | Producto/UI |
| `apps/client/app/(tabs)/wallet.tsx` | Eliminar la "P2P Transfer Section" (l.607-692), el estado de transferencia (l.177-185 y l.784-791), `handleFindRecipient` (~l.319-338) y `submitTransfer` (l.341-366). Quitar las pestañas `transfer_in`/`transfer_out` (l.305-306). | Producto/UI |
| `apps/driver/app/(tabs)/wallet.tsx` | Verificar que no exista UI de transferencia P2P (el grep no la mostró). Si aparece, eliminarla. | Verificación |
| `packages/i18n/src/locales/{es,en,pt}/common.json` | Eliminar las claves de transferencia: `transfer`, `transfer_title`, `transfer_phone`, `transfer_amount`, `transfer_note`, `transfer_confirm`, `transfer_success`, `transfer_to`, `transfer_insufficient`, `transfer_user_not_found`, `cannot_transfer_self`, `transfer_searching`, `transfer_sent`, `transfer_received`, `transfer_note_hint`, `transfer_failed` (l.59, 68-94, 397). **Conservar** `txn_transfer_received` / `txn_transfer_sent` (l.86-87) para mostrar transacciones históricas en el historial. | Limpieza |
| `packages/api` — `walletService` | Eliminar/deshabilitar los métodos `transferP2P` y `findUserByPhone` (ya sin llamadores en frontend). | Limpieza |
| `apps/client/store-metadata/app-store-review-notes.md` | Reescribir el punto 3 (l.49-52): quitar *"Users may transfer remaining balance to other verified users"*. El saldo solo se canjea por viajes; el reembolso de saldo no consumido se limita a cierre de cuenta (ver Paso 1.4). | Copy |
| `apps/admin` — sección "Transferencias P2P" (`admin.json:407`) | Renombrar a "Transferencias P2P (histórico)" — solo muestra registros legacy; no se generan nuevas. | Copy (menor) |

**[BACKEND] — obligatorio, fuera del alcance frontend:** deshabilitar el RPC `transfer_p2p` en Supabase. Mientras el endpoint exista, la capacidad de transferir valor entre usuarios sigue presente y TriciCoin **no es** closed-loop, sin importar la UI. Las transacciones históricas de tipo `transfer_in/out` permanecen en el ledger (correcto).

---

### Paso 1.2 — Mostrar el saldo en unidades de crédito, no como monto en USD
**Cierra:** F-C4 · **Tipo:** Producto/UI

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `apps/client/app/(tabs)/wallet.tsx` | Revertir el display primario "Wallet v2 USD" (l.392-396): el saldo principal vuelve a expresarse en unidades TriciCoin (`formatTriciCoin`) o como "≈ N viajes". El USD desaparece como denominación del saldo guardado. | Producto/UI |
| `apps/web/src/app/wallet/page.tsx` | Igual: saldo primario en créditos/unidades (l.499-504); el USD aparece **solo** en el momento de compra ("Total a cobrar"). | Producto/UI |

**[CONFIRMAR con vos]:** ¿cómo querés denominar el crédito? Opciones: (a) "X TriciCoin" como unidad neutra; (b) "≈ N viajes" estimados. Recomiendo mostrar la unidad TriciCoin como cifra primaria y "≈ N viajes" como ayuda secundaria.

---

### Paso 1.3 — Reencuadre de copy: "moneda virtual / billetera / wallet / monedero" → "créditos de viaje"
**Cierra:** F-C1, F-C3, F-C5, F-M4 · **Tipo:** Copy · **Depende de:** Paso 1.1

| Archivo | Cambio (actual → propuesto) | Tipo |
|---------|------|------|
| `packages/i18n/src/locales/es/web.json:222` (+ en:201, pt) `terms.payments_text` | "...el saldo de TriciCoin **(moneda virtual de la plataforma)**..." → "...el saldo de TriciCoin, **crédito de viaje prepago canjeable únicamente por servicios de transporte de TriciGo**..." | Copy |
| `apps/web/src/app/profile/help/page.tsx:22` | "TriciCoins es **nuestra moneda virtual**..." → "TriciCoin es el **crédito de viaje** de TriciGo: lo usás para pagar viajes en la app. No es dinero, no es una moneda y no se convierte a efectivo." | Copy |
| `apps/web/src/app/page.tsx:42` (FAQ JSON-LD) | "TriciCoin **(monedero digital)**" → "TriciCoin **(crédito de viaje)**" | Copy |
| `apps/web/src/app/page.tsx` (~l.166, HTML estático) | "Paga en efectivo, TriciCoin **o transferencia**" → "Paga en efectivo o con tu **crédito de viaje TriciGo**" (elimina "transferencia" como método — F-M4) | Copy |
| `apps/web/src/app/wallet/page.tsx:484,519` | h1 "**Billetera TriciCoin**" → "**Mis créditos de viaje**"; "Recargar billetera" → "Comprar créditos" | Copy |
| `packages/i18n/src/locales/{es,en,pt}/web.json:7` | `nav.wallet`: "Billetera"/"Wallet" → "Créditos" | Copy |
| `apps/client/app/(tabs)/wallet.tsx:387` | `wallet.title` "Billetera TriciCoin" → "Créditos TriciGo" | Copy |
| `packages/i18n/.../{rider,driver,common,admin}.json` | Pasada sistemática de claves user-facing: `category_wallet`, `type_wallet_credit/debit`, `notif_wallet`, etc. "Billetera/Wallet" → "Créditos de viaje / Trip credits". (Listado completo de claves al implementar.) | Copy |
| `apps/web/src/app/profile/referral/page.tsx:496` | "...acreditados directamente a tu **billetera**." → "...acreditados a tus **créditos de viaje**." | Copy |
| `apps/client/store-metadata/en/listing.md:33,39` | l.39 "**Digital wallet**: Manage your balance, view transactions, and **transfer funds**." → "**Trip credits**: check your balance and full transaction history." · l.33 "digital wallet balance" → "trip credit balance" | Copy |
| `apps/client/store-metadata/es/listing.md:36,44` | l.44 "**Billetera** con filtros... viajes o **transferencias**" → "**Créditos de viaje** — consultá tu saldo e historial de movimientos." · l.36 "saldo digital" → "crédito de viaje" | Copy |
| `apps/driver/app/(tabs)/wallet.tsx:159,179` | "Billetera" del conductor → **[CONFIRMAR]**: la del conductor es una cuenta de comisión/cuota, no de crédito de viaje. Propongo "Cuenta de conductor" o "Saldo". | Copy |

**[REVISIÓN LEGAL]** — la redacción final de `terms.payments_text` y de la FAQ conviene que la valide un abogado.

---

### Paso 1.4 — Cláusula closed-loop en T&C + consistencia de reembolso
**Cierra:** F-A1, F-A2 · **Tipo:** Copy + Dato/CMS

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `packages/i18n/src/locales/{es,en,pt}/web.json` (bloque `terms`) | Añadir claves nuevas `terms.tricicoin_nature_title` / `tricicoin_nature_text`. Texto base (reutiliza el lenguaje ya correcto de `apps/driver/app/onboarding/review.tsx:268`): *"Los créditos TriciCoin son saldo interno prepago, canjeable exclusivamente por servicios de transporte de TriciGo. No son dinero, no constituyen e-money, no son transferibles a otros usuarios ni convertibles a efectivo, y no son una cuenta de pago ni bancaria."* | Copy |
| `apps/web/src/app/terms/page.tsx` | Añadir el bloque de render para la nueva sección (la página itera claves discretas del i18n). | Copy/estructura |
| `terms.payments_text` (es:222 / en:201 / pt) | Ajustar la frase de reembolso para que sea coherente con la realidad post-1.1: el saldo no consumido se devuelve solo en cierre de cuenta / derecho de consumidor, no como cash-out a demanda. | Copy |

**[CMS] — paso de datos obligatorio:** los Términos en vivo vienen de `cms_content` (clave `terms`). Tras aprobar los textos, hay que actualizar el contenido en el panel admin `/content` o en la tabla `cms_content`. Editar el i18n solo cambia el fallback.

**[REVISIÓN LEGAL]** — la cláusula de naturaleza de TriciCoin y la política de reembolso deben validarse con abogado de pagos rumano, incluida la confirmación de que este diseño closed-loop efectivamente exime de licencia EMI ante el BNR.

---

### Paso 1.5 — Identidad del merchant (MACH DIGITAL TECH S.R.L.)
**Cierra:** F-A3, F-M3 (parcial) · **Tipo:** Copy + datos reales (§1)

> El sitio debe presentar **TriciGo como marca operada por MACH DIGITAL TECH S.R.L.** — ni "TriciGo Inc." ni "TriciGo SRL".

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `apps/web/src/app/profile/about/page.tsx:108` | "**TriciGo Inc.**" → bloque: *"TriciGo es un servicio operado por **MACH DIGITAL TECH S.R.L.**"* con CUI 54552055, Nr. RegCom J2026027319006, EUID y domicilio (Brașov, Rumanía). | Copy/datos |
| `apps/web/src/app/web-footer.tsx` + `packages/i18n/.../web.json` (bloque `footer`) | Añadir línea de identidad: "TriciGo · operado por MACH DIGITAL TECH S.R.L. · CUI 54552055 · RegCom J2026027319006 · EUID ___ · Str. Lungă nr. 149, Brașov, Rumanía". (La línea "La Habana, Cuba" puede quedar como zona de servicio.) | Copy/datos |
| `apps/web/src/app/layout.tsx:59-83` (JSON-LD) | `Organization`: `legalName: "MACH DIGITAL TECH S.R.L."`, `address` (Brașov, RO), `taxID: "54552055"`. La marca "TriciGo" va en `name` / `brand`. | Copy/datos |

---

## 4. Sprint 2 — Alta prioridad (antes del go-live)

### Paso 2.1 — Declarar el statement descriptor
**Cierra:** F-A4 · **Tipo:** Copy

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `packages/i18n/.../web.json` (bloque `terms`) | Nueva cláusula: *"El cargo aparecerá en tu estado de cuenta como **TRICIGO MOBILITY RO**."* (descriptor §1 dato 9) | Copy |
| `apps/web/src/app/wallet/page.tsx` + `apps/client/app/(tabs)/wallet.tsx` | Mostrar el descriptor en la pantalla de compra de créditos, antes de confirmar el pago. | Copy |

### Paso 2.2 — Página /refunds (reembolsos, chargebacks, disputas)
**Cierra:** F-A5, F-M2 · **Tipo:** Archivo nuevo

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `apps/web/src/app/refunds/page.tsx` | **NUEVO.** Política de reembolsos de viajes, devolución de saldo no consumido (coherente con 1.4), proceso de disputa, plazos, contacto. | Archivo nuevo |
| `packages/i18n/.../web.json` | Bloque `refunds` nuevo (es/en/pt). | Copy |
| `apps/web/src/app/web-footer.tsx` + `footer` i18n | Añadir enlace a /refunds. | Copy |
| `apps/web/src/app/sitemap.ts` | Añadir `/refunds`. | Config |

**[REVISIÓN LEGAL]** — parámetros y redacción de la política de reembolso.

### Paso 2.3 — Página /contact
**Cierra:** §5 ítem 8 · **Tipo:** Archivo nuevo

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `apps/web/src/app/contact/page.tsx` | **NUEVO.** Email de soporte + teléfono físico (§1 dato 6) + identidad TriciGo SRL. | Archivo nuevo |
| `packages/i18n/.../web.json` + `web-footer.tsx` + `sitemap.ts` | Bloque `contact`, enlace en footer, ruta en sitemap. | Copy/Config |

### Paso 2.4 — Política AML / uso aceptable
**Cierra:** F-A6 · **Tipo:** Copy

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `packages/i18n/.../web.json` (bloque `terms` o sección nueva) | Declarar: límites de recarga (hoy en código: `MIN_RECHARGE_USD=20` / `MAX=500` en `apps/client/app/(tabs)/wallet.tsx:876-877`), monitoreo de patrones anómalos, prohibición de uso del crédito para fines distintos a viajes. | Copy |

**[REVISIÓN LEGAL]** — contenido de la política AML/KYC.

### Paso 2.5 — GDPR / ANSPDCP en la Política de Privacidad
**Cierra:** F-A7 · **Tipo:** Copy + Dato/CMS

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `packages/i18n/.../web.json` (bloque `privacy`, es:169-207) | Añadir: responsable del tratamiento (TriciGo SRL + contacto), base legal por finalidad (Art. 6 GDPR), lista de sub-encargados y país (Supabase, Stripe, Mapbox, Sentry, PostHog — ya inventariados en `apps/client/store-metadata/data-safety.md`), mención de **ANSPDCP** como autoridad de control. | Copy |
| `apps/web/src/app/privacy/page.tsx` | Render de las secciones nuevas. | Copy/estructura |

**[CMS]** — actualizar `cms_content` clave `privacy`. **[REVISIÓN LEGAL]** — base legal y redacción.

### Paso 2.6 — Declaración PCI-DSS SAQ-A
**Cierra:** F-A8 · **Tipo:** Copy

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `apps/web/src/app/profile/about/page.tsx` o T&C | Declarar: el procesamiento de tarjetas es vía proveedor PCI-DSS Level 1; TriciGo SRL no almacena datos de tarjeta y califica como SAQ-A. (La arquitectura ya lo cumple — Stripe Elements / SDK nativo.) | Copy |

### Paso 2.7 — Screening de conductores contra listas SDN
**Cierra:** F-A9 · **Tipo:** Build [BACKEND]

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `apps/driver/app/onboarding/` + flujo de aprobación admin | Añadir, en la aprobación de documentos del conductor, un cribado del nombre contra OFAC SDN / Cuba Restricted List, con re-screening periódico. | Build |

**[BACKEND] + [REVISIÓN LEGAL]** — definir qué listas, qué proveedor (API de terceros vs. lista descargable de OFAC) y el procedimiento ante una coincidencia. Documentar el control para el underwriting.

### Paso 2.8 — Limpieza de referencias TropiPay
**Cierra:** F-A10 · **Tipo:** Limpieza

| Archivo | Cambio | Tipo |
|---------|--------|------|
| `apps/web/src/app/rides/[id]/page.tsx:27` | Quitar el label `tropipay: 'Tarjeta'` (o conservarlo solo si hay viajes legacy que lo necesiten para mostrarse). | Limpieza |
| `supabase/functions/_shared/email-templates/ride_receipt.ts:171` | Quitar `tropipay: 'TropiPay'` del mapa de labels del email. | Limpieza |
| `packages/types/src/enums.ts`, `packages/types/src/payment.ts` | Eliminar `'tropipay'` de `PaymentProvider`. `PaymentMethod` puede conservarlo para viajes legacy en DB (según `docs/PAYMENT_STRATEGY.md:46`). | Limpieza |
| `packages/utils/src/historyExport.ts` | Revisar el label `tropipay: 'Tarjeta (legacy)'`. | Limpieza |
| `README.md:47,67` (+ l.286,299,303,317,318) | Actualizar el stack de pagos: el proveedor es Stripe (no TropiPay). | Limpieza |

---

## 5. Sprint 3 — Pulido (primer mes post-aprobación)

| Paso | Archivo(s) | Cambio | Cierra |
|------|-----------|--------|--------|
| 3.1 | `packages/i18n/.../web.json` `terms.governing_law_text` (es:240) | Revisar la cláusula de ley aplicable/foro. **[REVISIÓN LEGAL]** — probable ley rumana/UE para la relación con el pagador. | F-M1 |
| 3.2 | `apps/web/src/app/layout.tsx:59-83` | Completar `LocalBusiness`/`Service` JSON-LD coherente con MCC de movilidad. | F-M3 |
| 3.3 | `supabase/functions/_shared/email-templates/wallet_receipt.ts`, `welcome.ts` | "wallet/billetera" → "créditos de viaje"; cambiar el emoji 💸 por 🛺/🎟️. | F-M5 |
| 3.4 | `apps/client/store-metadata/aso-keywords-private.md` | Reescribir como doc de ASO normal; eliminar toda la narrativa de "ocultar Cuba a Stripe" (premisa incorrecta para procesadores UE/RO). | F-M6 |
| 3.5 | Web vs. store-metadata | Dominio canónico confirmado: **`tricigo.com`**. Corregir en `apps/client/store-metadata/` y `apps/driver/store-metadata/` todo uso de `tricigo.app` → `tricigo.com` (incluida la URL de privacidad declarada a Google Play y `soporte@tricigo.app` → `soporte@tricigo.com`). | (consistencia) |

---

## 6. Resumen de archivos afectados

| Archivo | Pasos | Tipo predominante |
|---------|-------|-------------------|
| `apps/web/src/app/wallet/page.tsx` | 1.1, 1.2, 1.3, 2.1 | Producto/UI + Copy |
| `apps/client/app/(tabs)/wallet.tsx` | 1.1, 1.2, 1.3, 2.1, 2.4 | Producto/UI + Copy |
| `apps/driver/app/(tabs)/wallet.tsx` | 1.1 (verif.), 1.3 | Verificación + Copy |
| `packages/i18n/.../{es,en,pt}/web.json` | 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1 | Copy |
| `packages/i18n/.../{es,en,pt}/common.json` | 1.1 | Limpieza |
| `packages/i18n/.../{rider,driver,admin}.json` | 1.3 | Copy |
| `apps/web/src/app/page.tsx` | 1.3 | Copy |
| `apps/web/src/app/profile/help/page.tsx` | 1.3 | Copy |
| `apps/web/src/app/profile/about/page.tsx` | 1.5, 2.6 | Copy/datos |
| `apps/web/src/app/profile/referral/page.tsx` | 1.3 | Copy |
| `apps/web/src/app/layout.tsx` | 1.5, 3.2 | Copy/datos |
| `apps/web/src/app/web-footer.tsx` | 1.5, 2.2, 2.3 | Copy |
| `apps/web/src/app/terms/page.tsx` | 1.4 | Estructura |
| `apps/web/src/app/privacy/page.tsx` | 2.5 | Estructura |
| `apps/web/src/app/refunds/page.tsx` | 2.2 | **Archivo nuevo** |
| `apps/web/src/app/contact/page.tsx` | 2.3 | **Archivo nuevo** |
| `apps/web/src/app/sitemap.ts` | 2.2, 2.3 | Config |
| `apps/web/src/app/rides/[id]/page.tsx` | 2.8 | Limpieza |
| `apps/client/store-metadata/{en,es}/listing.md` | 1.3 | Copy |
| `apps/client/store-metadata/app-store-review-notes.md` | 1.1 | Copy |
| `apps/client/store-metadata/aso-keywords-private.md` | 3.4 | Copy |
| `supabase/functions/_shared/email-templates/{wallet_receipt,welcome,ride_receipt}.ts` | 1.1, 2.8, 3.3 | Copy/Limpieza |
| `packages/types/src/{enums,payment}.ts`, `packages/utils/src/historyExport.ts` | 2.8 | Limpieza |
| `packages/api` (`walletService`) | 1.1 | Limpieza |
| `README.md` | 2.8 | Limpieza |
| `apps/driver/app/onboarding/*` | 2.7 | Build |

---

## 7. Puntos [REVISIÓN LEGAL] y [BACKEND]

> **🔴 BLOQUEANTE — exposición OFAC / redes de tarjeta · [REVISIÓN LEGAL].** Estructura confirmada por contrato: merchant rumano (MACH DIGITAL TECH S.R.L.), operación 100 % en La Habana, pagadores en el exterior (incluido EE.UU.). Las redes Visa/Mastercard son estadounidenses y aplican OFAC a toda la red; un titular de tarjeta en EE.UU. pagando un servicio consumido en Cuba es una pregunta de sanciones que **no se resuelve ni con copy ni con la estructura rumana**. Requiere opinión de un abogado de sanciones **antes** de aplicar a NETOPIA/EuPlătesc. Es el único punto que NO debe avanzar bajo el criterio "lo defendible".

**[REVISIÓN LEGAL]** (avanzamos con lo defendible; estos quedan marcados para un abogado):
- Redacción de la cláusula de naturaleza closed-loop de TriciCoin (Paso 1.4).
- Confirmación de que el diseño closed-loop exime de licencia EMI ante el BNR (Paso 1.4).
- Política de reembolsos: parámetros y texto (Paso 2.2).
- Política AML/KYC: contenido (Paso 2.4).
- Base legal GDPR y redacción del aviso de privacidad (Paso 2.5).
- Cláusula de ley aplicable/foro (Paso 3.1).
- Listas y procedimiento de screening SDN (Paso 2.7).

**[BACKEND]** (obligatorios, fuera del alcance frontend de este plan):
- Deshabilitar el RPC `transfer_p2p` en Supabase (Paso 1.1) — **sin esto, la afirmación closed-loop es falsa.**
- Acotar la lógica de reembolso a método de pago original (Paso 1.4 / 2.2).
- Integración del screening SDN de conductores (Paso 2.7).

---

## 8. Verificación (cómo testear cada sprint)

**Tras Sprint 1:**
- `grep` de control: que **no** queden ocurrencias user-facing de "moneda virtual", "monedero", "billetera digital", "wallet" fuera de contexto legacy.
- Verificar que la sección "Enviar/Transferir TriciCoin" **no renderiza** en web ni en la app cliente.
- `pnpm build` de `apps/web` y `apps/admin` sin errores de tipos.
- Levantar Metro y revisar en el celular la pantalla de créditos (saldo en unidades, sin sección de transferencia) — ver protocolo en `CLAUDE.md`.
- Confirmar que los Términos renderizan la cláusula closed-loop nueva (i18n fallback **y** CMS).

**Tras Sprint 2:**
- `/refunds` y `/contact` resuelven y aparecen en `sitemap.xml` y en el footer.
- La Política de Privacidad muestra base legal GDPR y ANSPDCP.
- Sin referencias a "TropiPay" en frontend ni en el email `ride_receipt.ts`.

**Tras Sprint 3:**
- Dominio y email de soporte unificados; la URL de privacidad de las tiendas resuelve.

**Cierre:** re-ejecutar la auditoría (`AUDIT_PAYMENT_APPROVAL.md`) para confirmar que los 21 hallazgos están cerrados o marcados [REVISIÓN LEGAL] con seguimiento.

---

## 9. Orden de ejecución recomendado

1. Me pasás los datos de §1.
2. Implemento **Sprint 1** (Pasos 1.1 → 1.5) y te lo presento para revisión.
3. Vos (o tu equipo backend) ejecutan los **[BACKEND]** del Paso 1.1 — crítico antes de declarar closed-loop al procesador.
4. Implemento **Sprint 2**.
5. **Sprint 3** post-aprobación.
6. Re-auditoría.
