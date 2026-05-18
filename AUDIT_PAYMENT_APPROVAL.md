# Auditoría de Aprobación para Pasarela de Pago Rumana — TriciGo

**Entidad merchant:** MACH DIGITAL TECH S.R.L. (Rumanía) — marca del producto: TriciGo
**Fecha:** 2026-05-17
**Procesadores objetivo:** NETOPIA Payments, EuPlătesc (regulación BNR) — más reglas globales Visa / Mastercard
**Alcance auditado:** `apps/web`, `apps/admin`, `apps/client`, `apps/driver`, `packages/i18n`, `packages/types`, `packages/utils`, `store-metadata` de ambas apps, plantillas de email transaccional, `README.md`, metadata SEO, `manifest.json`, assets con texto.

---

## 0. Nota metodológica

Esta auditoría aplica el alcance acordado: **la operación en Cuba NO es un hallazgo**. La UE no sanciona Cuba; NETOPIA y EuPlătesc admiten merchants que operan allí. Por eso este reporte **no marca** las menciones de "Cuba", "La Habana", mapas cubanos, español de Cuba ni el marketing dirigido a la diáspora — todo eso es legítimo y queda fuera de la lista de hallazgos.

Lo que sí se audita: (1) lenguaje de remesa que recategorice un servicio de movilidad como envío de dinero; (2) TriciCoin presentada o construida como producto financiero (e-money / wallet / quasi-cash); (3) vínculos con entidades cubanas efectivamente sancionadas (SDN / Cuba Restricted List); (4) compliance positivo ausente.

**Sustancia vs. forma — leer antes de la Sección 2.** Varios hallazgos críticos sobre TriciCoin se pueden "arreglar" cambiando copy. Eso es **insuficiente y, por sí solo, riesgoso**: BNR y los esquemas de tarjeta evalúan la *función* del instrumento, no su etiqueta. Si TriciCoin permite transferencia de valor entre usuarios y reembolso a efectivo, entonces *es* un instrumento de pago / e-money aunque se le llame "créditos de viaje" — y describirlo como closed-loop ante el procesador sería una declaración inexacta. Los fixes de copy de la Sección 2 **solo son válidos si se acompañan del cambio de producto** descrito en F-C2 y F-A2. Renombrar sin cambiar la función traslada la inexactitud, no la elimina.

---

## 1. Resumen Ejecutivo

### Veredicto: **NECESITA TRABAJO**

No es "NO APROBABLE": el núcleo del negocio es genuinamente movilidad/ride-hailing (coherente con MCC 4121/4789), no hay lenguaje de remesa y no hay vínculos con entidades sancionadas. Tampoco es "APROBABLE": TriciCoin hoy se presenta **y funciona** como producto financiero, y falta toda la identificación del merchant rumano y las páginas legales obligatorias.

### Conteo de hallazgos

| Severidad | Cantidad |
|-----------|----------|
| 🔴 CRÍTICO | 5 |
| 🟠 ALTO | 10 |
| 🟡 MEDIO | 6 |
| **Total** | **21** |

Compliance positivo ausente (Sección 5): **10 de 12** ítems faltantes o parciales.

### Recomendación principal (3 líneas)

1. El bloqueante real **no es Cuba** — es que TriciCoin se describe como "moneda virtual / monedero" y, sobre todo, **se comporta** como producto financiero: transferencia P2P libre entre usuarios, reembolso a método de pago original y saldo presentado en USD; eso lo acerca a e-money y a los MCC prohibidos 6051/4829.
2. Antes de aplicar a NETOPIA/EuPlătesc hay que **decidir la naturaleza de TriciCoin**: o se vuelve genuinamente closed-loop (quitar transferencia P2P libre y cash-out) y entonces se describe con honestidad como crédito de viaje, o se asume que es e-money y se evalúa la licencia EMI con BNR — no hay un atajo de solo-copy.
3. En paralelo, agregar la identificación del merchant (MACH DIGITAL TECH S.R.L., CUI, EUID, RegCom, domicilio rumano), el statement descriptor declarado y las páginas legales ausentes (reembolsos/chargebacks, AML/KYC, base legal GDPR, PCI-DSS SAQ-A).

### Hallazgos positivos (a preservar)

- ✅ **Sin entidades sancionadas.** Cero referencias a GAESA, CIMEX, Gaviota, FAR, MININT, Banco Metropolitano, Fincimex, Cadeca en todo el repo.
- ✅ **Sin lenguaje de remesa.** Cero ocurrencias de "remesa", "remittance", "send money", "envía dinero a tu familia", "seres queridos". La app no se comercializa como envío de dinero.
- ✅ **Disclaimers closed-loop ya existentes** — buen material base, hoy infrautilizado:
  - `apps/client/app/(tabs)/wallet.tsx:1593` — sheet de recarga: *"El saldo se canjea exclusivamente por viajes físicos. No desbloquea contenido digital ni funciones premium dentro de la app."*
  - `apps/driver/app/onboarding/review.tsx:268` — *"Tu billetera es saldo interno canjeable por servicios de transporte físico — no es una transferencia internacional de dinero ni una cuenta bancaria."*
- ✅ **Sin logos de bancos/tarjetas cubanas** presentados como métodos de pago aceptados.
- ✅ El producto base (solicitud de viaje, matching de conductor, mapas, tarifas, tipos de vehículo) es coherente con un MCC de movilidad.

---

## 2. Hallazgos CRÍTICOS

> Recordatorio: los fixes de copy de F-C1, F-C3, F-C4 y F-C5 **solo son válidos** si se ejecuta primero el cambio de producto de F-C2 / F-A2. Renombrar un instrumento que sigue siendo transferible y reembolsable a efectivo no lo vuelve closed-loop.

---

### 🔴 F-C1 · TriciCoin descrita como "moneda virtual" en Términos y en la Ayuda

- **Archivo:**
  - `packages/i18n/src/locales/es/web.json:222` (clave `terms.payments_text`)
  - `packages/i18n/src/locales/en/web.json:201` · `packages/i18n/src/locales/pt/web.json` (`terms.payments_text`, ~l.201)
  - `apps/web/src/app/profile/help/page.tsx:22`
- **Snippet:**
  - `"Los pagos pueden realizarse en efectivo (CUP) o mediante el saldo de TriciCoin (moneda virtual de la plataforma)..."`
  - `"TriciCoins es nuestra moneda virtual. Puedes ganarlos con referidos, promociones y quests."`
- **Categoría:** TriciCoin financiero
- **Regla violada:** "Moneda virtual" posiciona a TriciCoin como producto financiero/quasi-cash. Es incompatible con MCC 4121/4789 y arrastra hacia MCC 6051. Un underwriter de NETOPIA/EuPlătesc que lea los T&C lo interpreta como instrumento de valor → exige licencia EMI o rechaza.
- **Fix sugerido:** Sustituir "moneda virtual de la plataforma" por **"crédito de viaje prepago, canjeable únicamente por servicios de transporte de TriciGo"**. En la FAQ: *"TriciCoin es el crédito de viaje de TriciGo: lo usás para pagar viajes dentro de la app. No es dinero, no es una moneda y no se puede convertir a efectivo."*
- **Procesadores afectados:** NETOPIA, EuPlătesc, Visa/MC (coherencia de MCC).

---

### 🔴 F-C2 · TriciCoin es transferible entre usuarios — feature de producto, no de copy

- **Archivo:**
  - `apps/web/src/app/wallet/page.tsx:646-728` (sección "Enviar TriciCoin": `handleFindRecipient`, `handleTransfer`, `walletService.transferP2P`)
  - `apps/client/app/(tabs)/wallet.tsx:607-692` (`t('wallet.transfer_title', { defaultValue: 'Transferir a otro usuario' })`, `submitTransfer` → `walletService.transferP2P`)
  - `packages/i18n/src/locales/{es,en,pt}/common.json:68-94` (`transfer_title: "Transferir TriciCoin"`, `transfer_phone`, `transfer_to`, `cannot_transfer_self`, `transfer_note_hint: "Ej: Compartimos el viaje"`)
  - `packages/i18n/src/locales/{es,en,pt}/admin.json:407` (`transfers_section: "Transferencias P2P"`)
- **Snippet:** `"Transferir a otro usuario"` · búsqueda de destinatario por teléfono (`findUserByPhone`) · monto libre + nota libre · transacciones `transfer_in` / `transfer_out`.
- **Categoría:** TriciCoin financiero (patrón crítico explícito: *"transferible entre usuarios"*).
- **Regla violada:** La transferencia libre de valor entre usuarios (monto arbitrario, destinatario arbitrario por teléfono, nota libre) es la característica que convierte a TriciCoin en **e-money / instrumento de transferencia de valor**. Bajo EMD2/PSD2 y regulación BNR esto requiere licencia EMI. También recategoriza el flujo hacia MCC 4829 (money transfer), prohibido. Es el hallazgo más grave del reporte.
- **Fix sugerido — cambio de producto, NO de copy:**
  - **Opción A (recomendada):** eliminar la función "transferir a otro usuario" por completo de `apps/web` y `apps/client`. TriciCoin solo se gasta en viajes propios.
  - **Opción B (si se necesita compartir costo):** reemplazarla por un **split de tarifa en el momento de la reserva** — acotado a un viaje real y concreto, limitado al monto de esa tarifa, sin transferencia de saldo libre. El valor nunca deja de ser "un viaje".
  - Hasta que esto se ejecute, TriciCoin **no puede declararse closed-loop** ante el procesador.
- **Procesadores afectados:** NETOPIA, EuPlătesc, Visa/MC (MCC 4829 prohibido), exposición regulatoria BNR (EMI).

---

### 🔴 F-C3 · TriciCoin presentada como "wallet / billetera / monedero digital" en todo el frontend

- **Archivo:**
  - `apps/web/src/app/page.tsx:42` — FAQ JSON-LD: `"...con TriciCoin (monedero digital)..."`
  - `apps/web/src/app/wallet/page.tsx:484` — `<h1>Billetera TriciCoin</h1>`
  - `packages/i18n/src/locales/es/web.json:7` — `nav.wallet: "Billetera"`
  - `apps/client/app/(tabs)/wallet.tsx:387` — `t('wallet.title', { defaultValue: 'Billetera TriciCoin' })`
  - `apps/driver/app/(tabs)/wallet.tsx:159,179` — `t('wallet.title', { defaultValue: 'Billetera' })`
  - `apps/web/src/app/profile/referral/page.tsx:496` — `"Recibís {{bonus}} CUP en TriciCoins, acreditados directamente a tu billetera."`
- **Snippet:** "Billetera TriciCoin", "monedero digital", `nav.wallet`.
- **Categoría:** TriciCoin financiero (patrón crítico: *"wallet", "billetera digital", "e-wallet", "monedero"*).
- **Regla violada:** "Wallet/billetera/monedero" es terminología de producto financiero de valor almacenado. Refuerza la lectura de e-money y la incoherencia con MCC de movilidad.
- **Fix sugerido:** Renombrar de forma consistente en los 4 apps + i18n (es/en/pt): "Billetera" / "Wallet" → **"Créditos TriciGo"** o **"Saldo de viajes"**; "monedero digital" → **"crédito de viaje en la app"**. Header `wallet/page.tsx:484` → **"Mis créditos de viaje"**.
- **Procesadores afectados:** NETOPIA, EuPlătesc, Visa/MC (coherencia MCC).

---

### 🔴 F-C4 · El saldo se presenta como un monto independiente en USD

- **Archivo:**
  - `apps/client/app/(tabs)/wallet.tsx:392-396` — *"Wallet v2 phase 2: switch primary display to USD"* → `formatTriciCoinUsd(balance.availableUsdCents)` como display primario del saldo.
  - `apps/web/src/app/wallet/page.tsx:499-504` — saldo + `~{formatTRCasUSD(...)}`; checkout "Total a cobrar $X USD".
  - `supabase/functions/_shared/email-templates/wallet_receipt.ts:67-68` — `"Importe acreditado" $X USD` + `"TriciCoin acreditados"`.
- **Snippet:** Saldo mostrado como `$ XX.XX USD` (monto primario).
- **Categoría:** TriciCoin financiero (patrón crítico: *"saldo en USD/EUR como producto independiente"*, *"UI que muestra TriciCoin como balance de 'dinero'"*).
- **Regla violada:** Un saldo denominado en USD, independiente y persistente, es indistinguible de un balance de dinero almacenado (e-money). Lo correcto para crédito de viaje closed-loop es expresar el saldo en **unidades de servicio** (créditos / viajes), no en divisa.
- **Fix sugerido:** Mostrar el saldo como **"X créditos"** o **"≈ N viajes"**; usar USD/CUP **solo** en el instante del cobro (precio del paquete de créditos que se compra), nunca como denominación del saldo guardado. Revisar la migración "Wallet v2 USD model" — denominar el balance en USD es exactamente el patrón a evitar.
- **Procesadores afectados:** NETOPIA, EuPlătesc, Visa/MC.

---

### 🔴 F-C5 · Ficha pública de tienda describe "Digital wallet" y "transfer funds"

- **Archivo:**
  - `apps/client/store-metadata/en/listing.md:39` — `"Digital wallet: Manage your balance, view transactions, and transfer funds."`
  - `apps/client/store-metadata/en/listing.md:33` — `"Pay with cash or digital wallet balance."`
  - `apps/client/store-metadata/es/listing.md:44` — `"Billetera con filtros — Filtra tu historial por recargas, viajes o transferencias."`
  - `apps/client/store-metadata/es/listing.md:36` — `"...Paga en efectivo o con saldo digital."`
- **Snippet:** `"Digital wallet ... transfer funds"`.
- **Categoría:** TriciCoin financiero + borde de lenguaje de remesa ("transfer funds" = mover fondos).
- **Regla violada:** Es texto **público** en Google Play / App Store, visible para cualquier diligencia de underwriting. "Digital wallet" + "transfer funds" describe explícitamente un producto financiero con movimiento de fondos, incompatible con un listing de app de movilidad (categoría declarada "Maps & Navigation").
- **Fix sugerido:** Reescribir la feature: EN → **"Trip credits: check your balance and full transaction history."**; ES → **"Créditos de viaje — consultá tu saldo e historial de movimientos."** Eliminar "transfer funds" / "transferencias" del listing. (El listing ya es sólido en lo demás: enfoque movilidad, sin Cuba, sin remesa.)
- **Procesadores afectados:** NETOPIA, EuPlătesc, revisión Apple/Google, Visa/MC.

---

## 3. Hallazgos ALTOS

---

### 🟠 F-A1 · Términos sin cláusula closed-loop de TriciCoin

- **Archivo:** `packages/i18n/src/locales/{es,en,pt}/web.json` — bloque `terms` (es: l.208-244). Clave `terms.payments_text` (es:222).
- **Snippet:** El único texto sobre TriciCoin es `payments_text`, que lo llama "moneda virtual" y menciona "no reembolsable… excepto para conductores mediante el proceso de redención". No existe cláusula de instrumento cerrado.
- **Categoría:** TriciCoin financiero (compliance ausente).
- **Regla violada:** Falta la declaración explícita: canjeable solo por servicios de TriciGo · no transferible · no es dinero ni e-money · no convertible a efectivo.
- **Fix sugerido:** Añadir cláusula dedicada "Naturaleza de los créditos TriciCoin" reutilizando el lenguaje **ya existente y correcto** de `apps/driver/app/onboarding/review.tsx:268` ("saldo interno canjeable por servicios de transporte físico — no es una transferencia internacional de dinero ni una cuenta bancaria"). Debe reflejar la realidad del producto **post-F-C2**.
- **Procesadores afectados:** NETOPIA, EuPlătesc (underwriting legal).

---

### 🟠 F-A2 · Contradicción Términos ↔ comportamiento real sobre reembolso

- **Archivo:** `packages/i18n/src/locales/es/web.json:222` vs. `apps/client/store-metadata/app-store-review-notes.md:49-52`.
- **Snippet:**
  - T&C: *"El saldo de TriciCoin no es reembolsable en efectivo excepto para conductores…"*
  - Notas de revisión App Store: *"Users may transfer remaining balance to other verified users (peer-to-peer, no commission), or contact support to request a refund of unused balance to the original payment method."*
- **Categoría:** TriciCoin financiero.
- **Regla violada:** Los T&C dicen una cosa y el procedimiento operativo declarado a Apple dice otra. El reembolso de saldo no usado al **método de pago original** es cash-out y, combinado con F-C2, confirma características de e-money. Documentos inconsistentes son una bandera directa de underwriting.
- **Fix sugerido:** Unificar. Si TriciCoin será closed-loop: el reembolso de saldo no usado se limita a casos de cierre de cuenta / derecho de consumidor, documentado como devolución de crédito de servicio prepago no consumido (no un cash-out a demanda), y los T&C lo reflejan. Nota: el "payout" a conductores por viajes realizados es liquidación de ingresos normal y **no** es un problema closed-loop — pero no debe describirse como que TriciCoin es "convertible a efectivo".
- **Procesadores afectados:** NETOPIA, EuPlătesc.

---

### 🟠 F-A3 · Identificación del merchant incorrecta y/o ausente

- **Archivo:**
  - `apps/web/src/app/profile/about/page.tsx:108` — `TriciGo Inc.`
  - `apps/web/src/app/layout.tsx:59-83` — JSON-LD `Organization` / `LocalBusiness` sin razón social legal, sin domicilio.
  - `packages/i18n/src/locales/es/web.json:15` — footer: única "ubicación" mostrada es `"La Habana, Cuba"`; no hay bloque de identidad del merchant rumano.
- **Snippet:** `"TriciGo Inc."` (entidad incorrecta; la real es **MACH DIGITAL TECH S.R.L.**, CUI 54552055 — "TriciGo" es la marca, no la entidad).
- **Categoría:** Compliance ausente / identificación del merchant.
- **Regla violada:** NETOPIA/EuPlătesc exigen identidad verificable y consistente del merchant. "TriciGo Inc." es incorrecto; faltan CUI, EUID, número RegCom y domicilio registrado en Rumanía. No es un problema de "mencionar Cuba" — es la **ausencia** de la entidad rumana.
- **Fix sugerido:** Reemplazar "TriciGo Inc." por **"MACH DIGITAL TECH S.R.L."** y presentar TriciGo como marca *operada por* esa entidad. Añadir en footer y en `/about`: razón social, CUI (54552055), EUID, Nr. RegCom (J2026027319006), domicilio (Brașov, Rumanía). Completar el JSON-LD `Organization` con `legalName`, `address` (RO) y `taxID`.
- **Procesadores afectados:** NETOPIA, EuPlătesc.

---

### 🟠 F-A4 · Statement descriptor no declarado al usuario

- **Archivo:** `packages/i18n/src/locales/{es,en,pt}/web.json` (bloque `terms`) — ausente. (Existe una propuesta interna en `apps/client/store-metadata/aso-keywords-private.md:95-99`: "TRICIGO RIDES", pero no en texto user-facing.)
- **Categoría:** Compliance ausente.
- **Regla violada:** No se informa al pagador cómo aparecerá el cargo en su tarjeta. Un descriptor inesperado dispara disputas y chargebacks.
- **Fix sugerido:** Declarar en T&C y en la pantalla de recarga: *"El cargo aparecerá en tu estado de cuenta como **TRICIGO MOBILITY RO**."* Configurar ese mismo descriptor en NETOPIA/EuPlătesc (descriptor neutro de movilidad — correcto, no es ocultamiento).
- **Procesadores afectados:** NETOPIA, EuPlătesc, Visa/MC (reglas de chargeback).

---

### 🟠 F-A5 · Política de chargebacks / reembolsos / disputas ausente

- **Archivo:** No existe ruta `/refunds` ni `/reembolsos` en `apps/web/src/app/`. El footer (`es/web.json:14-22`) solo enlaza Privacidad, Términos, Blog.
- **Categoría:** Compliance ausente.
- **Regla violada:** Los procesadores exigen una política de reembolsos/disputas pública y accesible. Existe el feature de disputa de viaje (`/rides/[id]/dispute`) pero no una política documentada.
- **Fix sugerido:** Crear `/refunds` con: condiciones de reembolso de viajes, política de saldo no consumido (coherente con F-A2), proceso de disputa, plazos, y canal de contacto. Enlazarla en el footer.
- **Procesadores afectados:** NETOPIA, EuPlătesc, Visa/MC.

---

### 🟠 F-A6 · Política AML/KYC del pagador no declarada

- **Archivo:** Ausente en `apps/web/src/app/` y en los bloques i18n legales.
- **Categoría:** Compliance ausente.
- **Regla violada:** Aunque el procesador hace el KYC del titular de tarjeta, el merchant debe declarar sus propias prácticas de prevención de fraude/lavado y los límites de recarga. Hoy los límites existen en código (`MIN_RECHARGE_USD = 20`, `MAX_RECHARGE_USD = 500` en `apps/client/app/(tabs)/wallet.tsx:876-877`) pero no se comunican como política.
- **Fix sugerido:** Publicar una sección AML/uso aceptable: límites de recarga, monitoreo de patrones anómalos, verificación de identidad ante umbrales, y prohibición de uso del crédito para fines distintos a viajes.
- **Procesadores afectados:** NETOPIA, EuPlătesc.

---

### 🟠 F-A7 · Política de privacidad sin base legal GDPR / ANSPDCP

- **Archivo:** `packages/i18n/src/locales/es/web.json:169-207` (bloque `privacy`).
- **Snippet:** El bloque enumera datos recogidos y "tus derechos" (acceso, corrección, eliminación, portabilidad) pero **no** declara base legal del tratamiento (Art. 6 GDPR), no menciona ANSPDCP (autoridad rumana), no nombra al responsable/DPO ni a los sub-encargados (Supabase, Stripe, Mapbox, Sentry, PostHog).
- **Categoría:** Compliance ausente.
- **Regla violada:** Un merchant rumano debe cumplir GDPR con supervisión de ANSPDCP. Falta base legal, identidad del responsable y transferencias internacionales.
- **Fix sugerido:** Añadir: responsable del tratamiento (TriciGo SRL + datos de contacto), base legal por finalidad (ejecución de contrato / interés legítimo / consentimiento), lista de sub-encargados y país, mención de ANSPDCP como autoridad de control y del derecho a reclamar. Reutilizar el inventario de datos ya documentado en `apps/client/store-metadata/data-safety.md`.
- **Procesadores afectados:** NETOPIA, EuPlătesc.

---

### 🟠 F-A8 · Sin declaración PCI-DSS SAQ-A

- **Archivo:** Ausente. Positivo de fondo: la integración usa Stripe Elements (`apps/web/src/app/wallet/page.tsx:11-12`) y Stripe React Native — la tarjeta nunca toca el servidor propio, lo que **califica para SAQ-A**.
- **Categoría:** Compliance ausente.
- **Regla violada:** El procesador espera ver declarado el alcance PCI. La arquitectura ya es SAQ-A pero no se declara.
- **Fix sugerido:** Declarar en T&C / `/about` que el procesamiento de tarjetas es vía proveedor PCI-DSS Level 1 y que TriciGo SRL califica como SAQ-A (sin almacenamiento de datos de tarjeta).
- **Procesadores afectados:** NETOPIA, EuPlătesc.

---

### 🟠 F-A9 · Sin mecanismo de screening de conductores contra listas SDN

- **Archivo:** Onboarding de conductor: `apps/driver/app/onboarding/` (`personal-info.tsx`, `documents.tsx`, `review.tsx`). No hay verificación contra OFAC SDN / Cuba Restricted List.
- **Categoría:** Compliance ausente (riesgo sanciones — reglas globales Visa/MC).
- **Regla violada:** Visa/Mastercard prohíben transacciones que beneficien a entidades/personas en SDN o Cuba Restricted List. Si un conductor (beneficiario del pago) estuviera listado, el flujo violaría reglas de esquema. Hoy no existe ningún cribado.
- **Fix sugerido:** Añadir al onboarding/aprobación de conductor un screening de nombre contra listas SDN/Restricted List (servicio de terceros o lista descargable de OFAC), con re-screening periódico. Documentar el control para el underwriting.
- **Procesadores afectados:** Visa/MC (reglas globales), NETOPIA, EuPlătesc.

---

### 🟠 F-A10 · Referencias residuales a TropiPay (gateway remesa-asociado)

- **Archivo:**
  - `apps/web/src/app/rides/[id]/page.tsx:27` — `tropipay: 'Tarjeta'` (label de método de pago en frontend).
  - `supabase/functions/_shared/email-templates/ride_receipt.ts:171` — `tropipay: 'TropiPay'` (label en email transaccional).
  - `packages/types/src/enums.ts` — `PaymentMethod` / `PaymentProvider` incluyen `'tropipay'`; `packages/utils/src/historyExport.ts` → `"Tarjeta (legacy)"`.
  - `README.md:47,67` — TropiPay listado como el stack de pagos.
- **Snippet:** `"TropiPay"` como método/proveedor de pago.
- **Categoría:** Entidad financiera Cuba-asociada — **[REVISIÓN HUMANA]**.
- **Regla violada:** TropiPay **no está en la lista SDN** (es una fintech registrada en España), por lo que **no es un hallazgo de entidad sancionada**. Pero está fuertemente asociada a remesas a Cuba — la propia doc del repo (`docs/PAYMENT_STRATEGY.md:13`) la llama *"Cuba-specific gateway"*. Un underwriter que vea "TropiPay" en el frontend, en un email o en el README puede abrir preguntas innecesarias. El código backend ya está marcado `DEPRECATED: TropiPay removed`.
- **Fix sugerido:** Completar la limpieza ya iniciada: quitar el label `tropipay` del frontend (`rides/[id]/page.tsx`) y del email (`ride_receipt.ts`); actualizar `README.md` para reflejar que el proveedor de pagos es Stripe; eliminar el valor del enum `PaymentProvider` (el de `PaymentMethod` puede mantenerse para viajes legacy en DB, según `docs/PAYMENT_STRATEGY.md:46`).
- **Procesadores afectados:** NETOPIA, EuPlătesc (revisión de diligencia).

---

## 4. Hallazgos MEDIOS

---

### 🟡 F-M1 · Ley aplicable = Cuba para una SRL rumana

- **Archivo:** `packages/i18n/src/locales/es/web.json:240` (`terms.governing_law_text`); equivalentes en/pt (en:219).
- **Snippet:** *"Estos términos se rigen por las leyes de la República de Cuba. Cualquier disputa será resuelta en los tribunales competentes de La Habana, Cuba."*
- **Categoría:** Coherencia de identidad del merchant — **[REVISIÓN HUMANA]**.
- **Regla violada:** No es un hallazgo de "mención de Cuba". El problema es de coherencia: una entidad rumana (**MACH DIGITAL TECH S.R.L.**) que contrata con pagadores en UE/EE.UU. y cuyos T&C se rigen exclusivamente por ley cubana puede chocar con derecho de consumidor UE y resultar incoherente en underwriting.
- **Fix sugerido:** Consultar con asesoría legal RO/UE la cláusula de ley aplicable y foro. Probable: ley rumana/UE para la relación contractual con el pagador, sin perjuicio de la normativa local de prestación del servicio.
- **Procesadores afectados:** NETOPIA, EuPlătesc (revisión legal).

---

### 🟡 F-M2 · Footer sin enlace a política de reembolsos

- **Archivo:** `packages/i18n/src/locales/es/web.json:14-22` (`footer`) — solo Privacidad, Términos, Blog.
- **Categoría:** Compliance ausente.
- **Fix sugerido:** Añadir enlace a `/refunds` (ver F-A5) y a `/contact` (ver Sección 5) en el footer de `apps/web`.
- **Procesadores afectados:** NETOPIA, EuPlătesc.

---

### 🟡 F-M3 · Schema.org `Organization` / `LocalBusiness` incompleto

- **Archivo:** `apps/web/src/app/layout.tsx:59-83`.
- **Snippet:** JSON-LD `Organization` y `LocalBusiness` sin `legalName`, sin `address`, sin identificadores fiscales.
- **Categoría:** Compliance ausente / coherencia.
- **Fix sugerido:** Completar `Organization` con `legalName: "TriciGo SRL"`, `address` (RO), `taxID`/`vatID`. Asegurar que `LocalBusiness`/`Service` declare el tipo de servicio de transporte (coherente con MCC 4121/4789).
- **Procesadores afectados:** NETOPIA, EuPlătesc (diligencia SEO/identidad).

---

### 🟡 F-M4 · "Transferencia" como método de pago en el landing

- **Archivo:** `apps/web/src/app/page.tsx` (~l.166), copy estático: *"Pagos flexibles — Paga en efectivo, TriciCoin o transferencia. Tú decides."*
- **Categoría:** TriciCoin financiero / ambigüedad.
- **Regla violada:** "Transferencia" sin contexto es ambiguo (¿transferencia bancaria? ¿transferencia de saldo?). En una página de movilidad puede leerse como movimiento de fondos.
- **Fix sugerido:** Reemplazar por los métodos reales y concretos: *"Paga en efectivo o con tu crédito de viaje TriciGo."* Eliminar "transferencia" como método listado.
- **Procesadores afectados:** NETOPIA, EuPlătesc.

---

### 🟡 F-M5 · Emails transaccionales con framing de "wallet / billetera"

- **Archivo:**
  - `supabase/functions/_shared/email-templates/wallet_receipt.ts:58-59,68,80` — *"Tu wallet ya tiene los TriciCoin disponibles… lo encontrás en tu billetera"*, hero *"X TriciCoin ya están en tu wallet"*.
  - `supabase/functions/_shared/email-templates/welcome.ts:39` — *"💸 Pagar en efectivo o con tu wallet TriciCoin."*
- **Categoría:** TriciCoin financiero (alcance: emails transaccionales).
- **Regla violada:** Los emails que recibe el pagador refuerzan el framing "wallet/billetera" y, en `welcome.ts`, el emoji 💸 (dinero) junto a TriciCoin. Coherente con F-C3.
- **Fix sugerido:** Reemplazar "wallet/billetera" por "créditos de viaje" en ambas plantillas; cambiar 💸 por 🛺/🎟️. El asunto y el comprobante deben hablar de "créditos de viaje acreditados", no de un saldo monetario.
- **Procesadores afectados:** NETOPIA, EuPlătesc.

---

### 🟡 F-M6 · `aso-keywords-private.md` construido sobre una premisa incorrecta

- **Archivo:** `apps/client/store-metadata/aso-keywords-private.md` (todo el archivo).
- **Snippet:** *"Estrategia: description pública limpia (sin Cuba) → Stripe seguro. Keywords privados con Cuba/Habana…"*
- **Categoría:** Observación / **[REVISIÓN HUMANA]**.
- **Regla violada:** Ninguna regla de procesador per se, pero la premisa del documento — *ocultar Cuba al procesador* — es **incorrecta y contraproducente** para el alcance rumano: NETOPIA/EuPlătesc admiten la operación en Cuba. Mantener un documento interno que describe una estrategia de ocultamiento es, además, un pasivo: si un procesador o regulador lo encuentra, sugiere intención de tergiversar. El esfuerzo correcto es el de este reporte (presentar el negocio con exactitud), no esconder la geografía.
- **Fix sugerido:** Reescribir el archivo como un doc de ASO normal: keywords legítimos sin la narrativa de "Stripe scrapers no ven". Mantener Cuba/Habana como keywords es válido (son términos de búsqueda reales). Eliminar toda la sección de "qué ocultar al procesador".
- **Procesadores afectados:** —

---

## 5. Lo que FALTA (compliance positivo ausente)

| # | Ítem | Estado | Referencia |
|---|------|--------|------------|
| 1 | Cláusula closed-loop de TriciCoin en T&C | ❌ AUSENTE | F-A1 |
| 2 | Identificación del merchant (SRL, CUI, EUID, dirección Rumanía) | ❌ AUSENTE (figura "TriciGo Inc.") | F-A3 |
| 3 | Statement descriptor declarado (TRICIGO MOBILITY RO) | ❌ AUSENTE en texto user-facing | F-A4 |
| 4 | Política de chargebacks y reembolsos | ❌ AUSENTE | F-A5 |
| 5 | Política AML/KYC del pagador | ❌ AUSENTE | F-A6 |
| 6 | Aviso GDPR + base legal del tratamiento | ❌ AUSENTE (privacy existe sin base legal/ANSPDCP) | F-A7 |
| 7 | Página /about con datos corporativos verificables | ⚠️ PARCIAL (existe, solo "TriciGo Inc." + email) | F-A3 |
| 8 | Página /contact con email + teléfono físicos | ❌ AUSENTE (no hay ruta /contact; email sí, teléfono no) | — |
| 9 | Footer con CUI, EUID, dirección Rumanía | ❌ AUSENTE | F-A3, F-M2 |
| 10 | Declaración PCI-DSS SAQ-A | ❌ AUSENTE (arquitectura ya califica) | F-A8 |
| 11 | Términos en ES + EN | ✅ PRESENTE (i18n es/en/pt) | — |
| 12 | Mecanismo de screening de conductor contra SDN list | ❌ AUSENTE | F-A9 |

**Resumen:** 1 de 12 presente, 1 parcial, 10 ausentes.

---

## 6. Alineación MCC

- **MCC recomendado:** **4121** (Taxicabs/Limousines) o **4789** (Transportation Services NEC). El producto base lo justifica: solicitud de viaje, matching de conductor, mapas, tarifas, tipos de vehículo, calificaciones.
- **Coherencia actual del copy: ~65%.**
  - A favor (núcleo movilidad): el flujo de viaje, el landing, las fichas de tienda, los tipos de servicio y el onboarding de conductor son coherentes con transporte.
  - En contra (arrastre hacia 6051/4829): TriciCoin descrita como "moneda virtual" y "wallet/billetera" (F-C1, F-C3), el feature de transferencia P2P entre usuarios (F-C2), el saldo denominado en USD (F-C4), "transfer funds" en la ficha pública (F-C5), "transferencia" como método de pago (F-M4).
- **MCC incompatibles a evitar:** 6051 (quasi-cash), 6012 (instituciones financieras), 4829 (money transfer). El feature de transferencia P2P (F-C2) es lo que más acerca el flujo a 4829.
- **Cambios para mejorar coherencia:** ejecutar F-C1 a F-C5 + F-A1/F-A2. Con el cambio de producto de F-C2 (quitar transferencia P2P libre) y el reencuadre del saldo como "créditos de viaje", la coherencia estimada sube a **~90-95 %**, plenamente alineada con MCC 4121/4789.

---

## 7. Plan de Remediación Priorizado

### Sprint 1 — Bloqueantes (antes de aplicar a NETOPIA/EuPlătesc)

1. **Decisión de producto sobre TriciCoin (F-C2, F-A2).** Definir con asesoría legal RO/UE si TriciCoin será closed-loop o e-money.
   - Si closed-loop: eliminar la transferencia P2P libre entre usuarios (o reemplazarla por split de tarifa acotado a un viaje); alinear el reembolso con un esquema de crédito de servicio no consumido.
   - Si e-money: detener la aplicación y evaluar la licencia EMI con BNR antes de continuar.
2. **Reencuadre de TriciCoin en copy (F-C1, F-C3, F-C4, F-C5)** — *solo después de (1)*. "moneda virtual"/"wallet"/"billetera" → "créditos de viaje"; saldo en unidades de servicio, no en USD; corregir la ficha EN de tienda.
3. **Identidad del merchant (F-A3).** "TriciGo Inc." → "TriciGo SRL"; añadir CUI, EUID, RegCom, domicilio RO en footer, `/about` y JSON-LD.
4. **Cláusula closed-loop en T&C (F-A1)** reflejando el producto resultante de (1).

### Sprint 2 — Alta prioridad (antes del go-live)

5. Statement descriptor declarado "TRICIGO MOBILITY RO" en T&C y pantalla de recarga (F-A4).
6. Crear `/refunds` (chargebacks/reembolsos/disputas) y `/contact` (email + teléfono); enlazar en footer (F-A5, F-M2, ítem 8).
7. Política AML/KYC del pagador, con límites de recarga declarados (F-A6).
8. Privacidad GDPR/ANSPDCP: base legal, responsable, sub-encargados (F-A7).
9. Declaración PCI-DSS SAQ-A (F-A8).
10. Screening de conductores contra listas SDN/Cuba Restricted List en onboarding (F-A9).
11. Limpieza de referencias TropiPay en frontend, email y README (F-A10).

### Sprint 3 — Pulido (primer mes post-aprobación)

12. Revisar cláusula de ley aplicable/foro con asesoría legal (F-M1).
13. Completar JSON-LD `Organization`/`LocalBusiness` (F-M3).
14. Corregir "transferencia" como método de pago en el landing (F-M4).
15. Reencuadre de copy en emails transaccionales (F-M5).
16. Reescribir `aso-keywords-private.md` sin la narrativa de ocultamiento (F-M6).

---

## Anexo · Cobertura de la auditoría

- **Apps:** `apps/web` (Next.js, público), `apps/admin` (Next.js, interno), `apps/client` y `apps/driver` (Expo/React Native).
- **Packages:** `i18n` (locales es/en/pt — namespaces web/common/rider/driver/admin), `types`, `utils`.
- **Otros:** `store-metadata` de cliente y conductor (listings es/en, ASO, review notes, data-safety), plantillas de email transaccional (`supabase/functions/_shared/email-templates/`), `README.md`, `manifest.json`, `og-image.svg`, metadata SEO y JSON-LD.
- **Excluidos:** `node_modules`, `.next`, `dist`, `build`, `coverage`.
- **Búsquedas de entidades sancionadas** (GAESA, CIMEX, Gaviota, FAR, MININT, Banco Metropolitano, Fincimex, Cadeca, Bandec, ETECSA, MLC): **0 coincidencias**.
- **Búsquedas de lenguaje de remesa** (remesa, remittance, send money, envía dinero a tu familia, seres queridos): **0 coincidencias**.
- **No se auditaron como hallazgo** las menciones de Cuba/La Habana/español cubano ni el marketing a la diáspora, conforme al alcance acordado.
