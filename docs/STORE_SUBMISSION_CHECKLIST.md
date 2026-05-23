# Store Submission Checklist — TriciGo Cliente + Conductor

> Punch list accionable para llevar TriciGo Cliente (`app.tricigo.client`) y TriciGo Conductor (`app.tricigo.driver`) a Apple App Store + Google Play. Cada ítem indica **quién** lo hace (humano vs. automatizable), **dependencias**, **comandos exactos** y **criterio de done**.
>
> Fuente: gaps abiertos al cerrar PR #166 (FD1) en sesión 2026-05-23. Para contexto de severidad ver `docs/STORE_READINESS_CLIENT.md` + `docs/STORE_READINESS_DRIVER.md`.

---

## Estado al 2026-05-23

| Categoría | Cliente | Driver |
|---|---|---|
| Hard-delete account flow (B2/D1/W2 + DD1) | ✅ código mergeado + edge fn desplegada + migración 00287 aplicada en prod | ✅ código mergeado, **falta verificar storage cleanup driver-documents real** |
| Prominent disclosure background location (W8) | N/A | ✅ código mergeado (PR #164) |
| Background Location Declaration Form draft (BD4) | N/A | ✅ draft escrito, **falta grabar video + screenshots** |
| Stripe SDK cleanup + ATT docs (D3/W1) | ✅ mergeado (PR #165) | ✅ N/A (driver nunca tuvo Stripe) |
| Background location funcional (FD1) | N/A | ✅ TaskManager wired (PR #166), **falta nuevo APK + test celu** |

**Lo que queda son entregables humanos / operacionales** — 7 ítems, ninguno de código.

---

## P0 — Bloqueantes de submit (NO se puede mandar a review sin esto)

### 1. Apple Developer Program enrollment

| | |
|---|---|
| **Owner** | Humano (Eduardo) |
| **Dependencia** | D-U-N-S Number (gratis, 1-2 semanas si la empresa no lo tiene) |
| **Costo** | USD 99/año |
| **Tiempo** | 2-4 semanas si es organización (1 día si individual) |
| **URL** | https://developer.apple.com/programs/enroll/ |
| **Done cuando** | Tenés `Team ID` (10 caracteres alfanuméricos) visible en https://developer.apple.com/account/#MembershipDetailsCard |

**Bloquea:** ítems 2, 3, 5, 6, 7.

---

### 2. Google Play Console enrollment

| | |
|---|---|
| **Owner** | Humano (Eduardo) |
| **Dependencia** | Tarjeta de crédito o débito que acepte cobros en USD desde Google |
| **Costo** | USD 25 one-time |
| **Tiempo** | 1-3 días (verificación de identidad) |
| **URL** | https://play.google.com/console/signup |
| **Done cuando** | Podés crear una "App" nueva en https://play.google.com/console/u/0/developers/<dev-id>/app-list y ves el `applicationId` `app.tricigo.client` + `app.tricigo.driver` reservados |

**Bloquea:** ítems 4, 5, 6, 7.

> **Cuba/OFAC nota:** Google Play en Cuba está parcialmente bloqueado por OFAC. La **entidad legal del developer account NO puede estar registrada en Cuba** (usar entidad en otro país: Panamá, México, USA, etc.). Distribución alternativa para usuarios cubanos: APK sideload + AppGallery (Huawei) + mirror propio en `tricigo.com/download`. No es un bloqueante de submit, es una decisión de distribución.

---

### 3. Llenar `eas.json` con `ascAppId` + `appleTeamId` (BD1)

| | |
|---|---|
| **Owner** | Humano + asistente |
| **Dependencia** | Ítem 1 (Apple Developer enrollment) |
| **Tiempo** | 10 min |

**Estado actual** (verificado 2026-05-23 commit `a098dcd`):

```json
// apps/client/eas.json:46-47
// apps/driver/eas.json:46-47
"ascAppId": "FILL_ME",
"appleTeamId": "FILL_ME"
```

**Pasos:**

1. En App Store Connect, crear ambas apps:
   - https://appstoreconnect.apple.com/apps → "+" → "New App"
   - Bundle ID `app.tricigo.client` → SKU `tricigo-client-001` → nombre "TriciGo"
   - Bundle ID `app.tricigo.driver` → SKU `tricigo-driver-001` → nombre "TriciGo Conductor"
2. Copiar el `ascAppId` (visible en URL: `apps/<ascAppId>/appstore`) — número de 10 dígitos por app.
3. Team ID desde https://developer.apple.com/account/#MembershipDetailsCard.
4. Reemplazar los 4 `FILL_ME` (2 por app). Commit:
   ```
   chore: fill ascAppId + appleTeamId in eas.json (cliente + driver)
   ```

**Done cuando:**
- `grep -r "FILL_ME" apps/client/eas.json apps/driver/eas.json` no devuelve nada.
- `npx eas-cli submit --profile production --platform ios --non-interactive` no se queja por falta de IDs.

---

## P1 — Bloqueantes de review (Apple/Play van a rechazar sin esto)

### 4. Grabar video Background Location Declaration Form (BD4)

| | |
|---|---|
| **Owner** | Humano (Eduardo) |
| **Dependencia** | Nuevo APK driver con FD1 wired (ítem 5) |
| **Tiempo** | 30-45 min (grabar + editar + subir) |
| **Especificaciones Play Console** | Video ≤30s, formato MP4/MOV, mostrando flow end-to-end |

**Qué grabar (script):**

1. **0-3s** — Abrir TriciGo Conductor, login con número de prueba (`+5355555555` o equivalente seed).
2. **3-7s** — Tap "Conectarme" (toggle online). Mostrar el `Alert.alert` de foreground location en español: "TriciGo necesita acceso a tu ubicación para encontrar pasajeros cerca…"
3. **7-12s** — Aceptar foreground permission. Mostrar dashboard del driver online.
4. **12-17s** — Llegar un ride simulado (push notification "Nuevo viaje"). Aceptar.
5. **17-22s** — **Punto crítico**: aparece el Alert de **prominent disclosure** con texto completo en español: "Compartir ubicación durante el viaje" + "ubicación" + "segundo plano / Siempre" + nombre de la feature + CTA "Permitir". Mostrar el texto completo legible (zoom in si hace falta).
6. **22-25s** — Tap "Permitir" → aparece el prompt de iOS/Android nativo pidiendo "Allow all the time".
7. **25-30s** — Conceder. Mostrar la **notificación persistente en Android** ("TriciGo Conductor — Compartiendo tu ubicación…") O el **blue indicator de iOS** en la status bar.

**Done cuando:**
- Video ≤30s en `docs/store-assets/driver/background-location-flow.mp4`.
- Subido al campo "Background location explanation video" en Play Console → Policy → Personal and sensitive information → Permissions → Background location.

**Screenshot complementario** (mismo flow):
- Frame del Alert de prominent disclosure → `docs/store-assets/driver/prominent-disclosure-alert.png`.
- Frame de la notificación persistente Android → `docs/store-assets/driver/foreground-service-notification.png`.

---

### 5. EAS Build production cliente + driver

| | |
|---|---|
| **Owner** | Asistente (puede ejecutar) o humano |
| **Dependencia** | Ítem 3 (eas.json completo) si va a submit directo; si no, solo cuenta Expo |
| **Tiempo** | 20-40 min de compilación por plataforma por app (4 builds total) |
| **Costo** | Free tier de EAS Build: 30 builds/mes. Si se excede, USD 29/mes Production plan |

**Comandos:**

```bash
# Cliente — Android
cd apps/client && npx eas-cli build --profile production --platform android --non-interactive

# Cliente — iOS
cd apps/client && npx eas-cli build --profile production --platform ios --non-interactive

# Driver — Android
cd apps/driver && npx eas-cli build --profile production --platform android --non-interactive

# Driver — iOS
cd apps/driver && npx eas-cli build --profile production --platform ios --non-interactive
```

**Importante para el driver iOS+Android:** este build incluye `expo-task-manager` (PR #166). Si compila sin error, FD1 funcional está validado a nivel native. Los dev clients viejos van a crashear al cargar el bundle porque no tienen el módulo nativo — necesitás un APK nuevo también para QA, no solo para production.

**Done cuando:**
- 4 builds en estado "Finished" en https://expo.dev/accounts/agencia-seniors/projects/tricigo-client/builds y `…/tricigo-driver/builds`.
- AAB descargable para Play + IPA para App Store por cada app.

---

### 6. Submit a App Store + Play Console

| | |
|---|---|
| **Owner** | Humano (review notes / data safety se llenan manualmente) + asistente (puede automatizar el upload) |
| **Dependencia** | Ítems 1, 2, 3, 4, 5 |
| **Tiempo** | 30 min de llenado de formularios + 1-7 días de review |

**Apple App Store Connect — pasos:**

1. App Information → Privacy Policy URL: `https://tricigo.com/privacy`.
2. App Information → App Review → Notes: copiar contenido de `apps/client/store-metadata/app-store-review-notes.md` o `apps/driver/store-metadata/app-store-review-notes.md` según app.
3. App Information → App Review → Demo credentials:
   - Phone: `+1 415 555 0101`
   - OTP code: `000000` (override DEV/Apple Review)
4. App Privacy → Data Types: usar el archivo `data-safety.md` como referencia para llenar los toggles de Apple.
5. Pricing → Free (las 2 apps).
6. Build → seleccionar el IPA recién subido por EAS.
7. App Review Information → Sign-In Required → ON (driver) / OFF (cliente — guest puede ver el mapa).
8. Submit for Review.

**Comando de upload (alternativa al manual):**
```bash
cd apps/client && npx eas-cli submit --profile production --platform ios --non-interactive
cd apps/driver && npx eas-cli submit --profile production --platform ios --non-interactive
```

**Google Play Console — pasos:**

1. App content → Privacy Policy: `https://tricigo.com/privacy`.
2. App content → Data Safety: llenar el form usando `apps/<app>/store-metadata/data-safety.md` como referencia exacta. **CRÍTICO**: declarar Location como "Collected + Shared" para el driver, ubicarlo bajo "App functionality".
3. App content → Permissions → Background Location: subir el video del ítem 4 + screenshots.
4. App content → Sensitive App Permissions → Background Location → "Add declaration": pegar el texto de `apps/driver/store-metadata/background-location-declaration-form.md`.
5. Production → Create new release → upload AAB.
6. Pricing & distribution → Free.
7. Review and rollout.

**Comando de upload:**
```bash
cd apps/client && npx eas-cli submit --profile production --platform android --non-interactive
cd apps/driver && npx eas-cli submit --profile production --platform android --non-interactive
```

> Necesita `google-service-account.json` en la raíz de cada app/. Generar en Google Play Console → API access → Service accounts → "Create new service account".

**Done cuando:**
- Estado en App Store Connect: "Waiting for Review" (24-48hr) → "In Review" → "Pending Developer Release" → release manual.
- Estado en Play Console: "In review" (1-7 días) → "Available on Google Play".

---

## P2 — Pre-launch validation (recomendado, no bloqueante de submit pero sí de calidad)

### 7. Smoke test en celular gama baja (Redmi 9A / Samsung A03 Core / similar)

| | |
|---|---|
| **Owner** | Humano (necesita el dispositivo físico) |
| **Dependencia** | Ítem 5 (APK production) |
| **Tiempo** | 1-2 horas |
| **Target Cuba** | Redmi 9A, Samsung A03 Core, Tecno Spark, Itel A56 |

**Checklist mínimo (cliente):**
- [ ] Cold start <2.5s (medir con cronómetro desde tap del icono hasta primera interacción posible).
- [ ] APK size <30MB (descomprimido en `/data/app/`).
- [ ] Mapa carga sin freezes (Mapbox + estilo dark mode).
- [ ] Búsqueda de direcciones responde en <1s con 100 resultados típicos.
- [ ] Booking flow completo no crashea con conexión 3G simulada (Chrome DevTools throttle si pruebas en web; modo avión + datos cuando hay buena señal vs cuando no en celu).
- [ ] Logout + login con cuenta diferente funciona (BUG-299b ya fixed pero re-verificar en gama baja).
- [ ] Eliminar cuenta → vuelve a login, re-login con mismo número crea cuenta nueva (verifica que migración 00287 + edge fn `delete-account` funcionan en prod).

**Checklist mínimo (driver):**
- [ ] Cold start <3s (acepta más tiempo porque carga mapa + ride dispatch).
- [ ] Online toggle no degrada battery >5%/hora estando idle (sin rides).
- [ ] Aceptar ride simulado → tracking en background funciona (FD1 — minimizar app por 5 min y verificar que el cliente ve el marker moverse).
- [ ] Notificación persistente "TriciGo Conductor" aparece y NO desaparece al swipe (la app debe tener `STICKY` + foreground service activo).
- [ ] Battery drain con ride activo: medir antes/después de un ride simulado de 10 min → <10% de drain.
- [ ] Onboarding → upload de 4 KYC docs sin crashes (cada uno con compress + EXIF strip).
- [ ] Cashout NO está visible (verificar que la migración `00273_remove_driver_cashout.sql` realmente eliminó el botón en gama baja también).

**Done cuando:**
- Spreadsheet o issue con cada checkbox tickeado + el modelo de celu + APK version + commit SHA.

---

## Apéndice: ítems P3 (Fase 2, post-submit)

Listados pero NO bloqueantes de la primera submission:

- Cron job de purge total post-anonymization (rides anonymizados >5 años se borran).
- Login web flow para account deletion sin app (magic link).
- Re-confirmación SMS antes del hard-delete (extra security layer).
- KYC documents retention policy automatizada (edge function que borra docs N meses post-driver-inactivo).
- Pre-Launch Report Google automatic (Firebase Test Lab — necesita demo credentials configuradas en Play Console).
- Baseline Profiles Android (optimización de cold start, opcional).
- DSA trader status UE si se distribuirá en Europa.
- Reporting corporate en admin (separar commission corporate vs particular en revenue reports).

---

## Estado de tracking en producción

| Operación | Estado | Verificado |
|---|---|---|
| Migración 00287 (`anonymize_user_references` + anonymous user) | ✅ Aplicada | 2026-05-23 vía MCP `apply_migration` |
| Edge function `delete-account` v1 | ✅ ACTIVE | 2026-05-23 vía MCP `deploy_edge_function`, sha256 `c676a0ba…` |
| `auth.users.00000000-…-099` (FK anonymization target) | ✅ Existe | 2026-05-23 SELECT confirmado |
| `public.users.00000000-…-099` (mirror para FK targeting) | ✅ Existe | 2026-05-23 SELECT confirmado |

Cualquier nuevo deploy de DB / edge function debe actualizarse acá con su fecha de aplicación.
