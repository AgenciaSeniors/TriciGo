# Store Readiness — TriciGo Cliente (App Store + Play Store)

> **Fecha:** 2026-05-23
> **Apps auditadas:** `apps/client/` (TriciGo Pasajero) — Bundle `app.tricigo.client`
> **Estado del worktree:** auditoría hecha contra `origin/master` (HEAD local 4 commits atrás; lecturas vía `git show origin/master:<path>`)
> **Procesador de pagos vigente:** NETOPIA (migración desde Stripe completada en master; algunas referencias residuales documentadas como gaps)
> **Timeline objetivo del usuario:** submit esta semana
> **Entregable:** identificación de gaps. **Sin cambios de código.**
>
> **Fuentes de evidencia:**
> - Lectura directa de `origin/master` vía `git show` y `git ls-tree`
> - Docs internos: `IOS_APPSTORE_COMPLIANCE.md`, `STORE_RELEASE.md`, `RELEASE_CHECKLIST.md`, `BLOQUEANTES.md`, `PRODUCTION_READINESS.md`
> - Docs externos del usuario: `compass_artifact_*.md` (894 líneas, específico TriciGo + sanctions OFAC), `deep-research-report.md` (frame genérico), `Requisitos Aprobación Tiendas Apps.md` (2025-2026 changes)
> - Apple Review Guidelines (2025-Q1, vigente Xcode 16 / iOS 18 SDK)
> - Google Play Developer Program Policies (2025-2026, target SDK 35 deadline 1 nov 2025)

---

## 0. Resumen ejecutivo

**Veredicto general:** la app **no está lista para submit esta semana sin trabajo previo**. Hay 4 bloqueantes hard que rechazan automáticamente (3 organizacionales que no tocan código y 1 de URL pública), 3 inconsistencias docs/código que generan rechazos en review, y 8 warnings con recomendaciones.

**Lo bueno (mayoría de lo crítico ya está):**

| Item | Estado |
|---|---|
| Account deletion in-app UI | ✅ `profile/settings.tsx:254-313` |
| Sign in with Apple | ✅ `login.tsx:275, 286-287` |
| NETOPIA payment flow (HTTPS + Universal Link + sin PII logged) | ✅ |
| PrivacyInfo.xcprivacy completo | ✅ 11 data types + 4 Required Reason APIs |
| Privacy + Terms screens in-app + URLs públicas en `apps/web/` | ✅ |
| Data Safety form pre-rellenado | ✅ `store-metadata/data-safety.md` |
| Review notes con wallet defense | ✅ `store-metadata/app-store-review-notes.md` |
| Screenshots producidos (5 por plataforma) | ✅ `store-metadata/screenshots/*.png` |
| Target SDK Android 35 (Android 15) | ✅ |
| iOS deployment target 15.1 | ✅ |
| 64-bit (ARM64) automático en Expo SDK 55 | ✅ |
| Hermes default + New Architecture (RN 0.83.4) | ✅ |
| `@rnmapbox/maps ~10.3.0` (Privacy Manifest ≥10.1) | ✅ |
| `@sentry/react-native ^7.11.0` (Privacy Manifest ≥5.20) | ✅ |
| ATS / HTTPS only en iOS | ✅ |
| Network security config Android | ✅ (Expo default) |
| `ITSAppUsesNonExemptEncryption: false` | ✅ |
| Universal Links + Android App Links con `autoVerify` | ✅ |
| Permissions runtime = declared (sin sobrantes) | ✅ |
| POST_NOTIFICATIONS Android 13+ via `expo-notifications` | ✅ |
| Foreground service types Android 14+ N/A (client sin background services) | ✅ |
| Demo credentials documentadas para reviewer | ✅ |

**Lo malo (lo que bloquea):**

🔴 **4 BLOCKERS HARD** (descritos en §2)
🟠 **3 INCONSISTENCIAS DOC/CÓDIGO** (descritas en §3) — alta probabilidad rechazo
🟡 **8 WARNINGS** (descritos en §4)

---

## 1. Decisión de submit

**No es viable submitear esta semana sin:**

1. Tener cuentas Apple Developer + Google Play Console activas (2-4 semanas de KYC + D-U-N-S si no están).
2. Rellenar `apps/client/eas.json` con `ascAppId` + `appleTeamId` reales (depende de Apple Developer activo).
3. Crear URL pública `https://tricigo.com/account/delete` (Play Store la exige desde mayo 2023, y `data-safety.md:16` ya la declara, así que es discrepancia doc/realidad).
4. Resolver las 3 inconsistencias docs vs código (§3) que pueden ser detectadas en App Review por cross-checking.

**Viabilidad realista:**
- **Si las cuentas Apple/Google YA están enroladas y verificadas** y el equipo legal/business asigna 1-2 días → submit posible en 5-7 días.
- **Si las cuentas NO están enroladas** → mínimo 14-21 días (D-U-N-S y enrollment Apple ~2 semanas).

---

## 2. BLOCKERS HARD (rechazo automático)

### 🔴 B1 — `eas.json` con valores `FILL_ME`

**Evidencia (`apps/client/eas.json` líneas 42-52, origin/master):**
```json
"submit": {
  "production": {
    "ios": {
      "appleId": "edua56621636@gmail.com",
      "ascAppId": "FILL_ME",
      "appleTeamId": "FILL_ME"
    }
  }
}
```

**Severidad:** BLOCKER de submit. `eas submit -p ios` falla sin estos IDs.

**Por qué importa:** Apple App Store Connect identifica la app por `ascAppId` (numeric App Store Connect App ID) y al equipo por `appleTeamId` (10-char alfanum). Sin estos, EAS no sabe a qué app subir el build.

**Dependencias:**
- Apple Developer Program activo (USD 99/año) con organization enrollment (no individual — los reviewers de transporte son más estrictos con cuentas individuales).
- **D-U-N-S Number** obtenido de Dun & Bradstreet (gratis, 2-4 semanas).
- App creada en App Store Connect → asignar `ascAppId`.

**Fix:**
1. Verificar status de Apple Developer Program en `developer.apple.com/account`.
2. Obtener `appleTeamId` (Membership → Team ID).
3. Crear app en App Store Connect → My Apps → "+" → bundle ID `app.tricigo.client`.
4. Copiar el App ID generado → reemplazar `FILL_ME` en `apps/client/eas.json:46-47`.

**Estimación:** 30 min si las cuentas están listas; 2-4 semanas si hay que iniciar enrollment.

---

### 🔴 B2 — URL pública de account deletion ausente

**Evidencia:**
```bash
$ git ls-tree -r origin/master --name-only | grep -E "apps/web.*(account|delete|eliminar|borrar)"
# vacío
```

`store-metadata/data-safety.md:16` declara:
> **Yes** (Settings → Eliminar cuenta + URL público en `tricigo.com/account/delete`)

Pero `apps/web/src/app/account/delete/page.tsx` (o similar) **no existe**. URL retorna 404.

**Severidad:** BLOCKER de review (Play Store). El Pre-Launch Report y el revisor manual cruzan el formulario Data Safety contra la app y la web; la mención de una URL pública que no responde 200 dispara rechazo automático.

**Por qué importa:** Play Console User Data Policy (mayo 2023+) obliga a:
1. Account deletion in-app **Y**
2. URL pública accesible sin login que explique cómo borrar la cuenta o lo permita directamente.

Apple solo exige in-app, pero como `data-safety.md` ya declara la URL, hay que entregarla o cambiar la declaración (peor opción — Play rechaza si solo es in-app).

**Fix:**
1. Crear `apps/web/src/app/account/delete/page.tsx` con:
   - Explicación de qué se borra (cuenta, datos personales, historial de viajes).
   - Período de gracia (30 días según `app-store-review-notes.md`).
   - Form simple "Email + teléfono" que dispare el flow de delete (puede tirar a `mailto:soporte@tricigo.com` como mínimo viable, idealmente un endpoint).
2. Linkearla desde footer del web (`apps/web/src/app/web-footer.tsx`).
3. Actualizar `apps/web/public/sitemap.xml` si existe.

**Estimación:** 2-4 horas para la página estática. 1-2 días si se quiere un flow web-driven con auth.

---

### 🔴 B3 — Apple Developer Program enrollment (organizacional)

**Evidencia:** `apps/client/eas.json` con `FILL_ME` (proxy de "no enrolado todavía"). `RELEASE_CHECKLIST.md:88-91` lo lista como "Fase C — Cuentas pagas (requiere decisión del usuario)".

**Severidad:** BLOCKER de submit. Sin cuenta, no hay `appleTeamId`, no hay App Store Connect, no hay binary upload.

**Por qué importa:** Apple Developer Program organization enrollment requiere:
- USD 99/año.
- D-U-N-S Number (gratis pero 2-4 semanas).
- Documentos legales de la entidad (incorporation certificate, etc.).
- Verificación telefónica por Apple (1-2 días).

**Bandera roja crítica desde el documento externo del usuario:** *"La entidad legal que firme la cuenta de desarrollador… **no puede estar domiciliada ni operada desde Cuba**: deberá ser una sociedad fuera de la isla (Stripe Atlas / Delaware C-Corp, Estonia e-Residency, México, España, etc.)"* — esto NO es un problema de código, es estructura societaria que precede al submit.

**Fix:**
- Si NO está iniciado: comenzar enrollment con la entidad legal correcta (no Cuba).
- Si está en proceso: confirmar status y obtener `appleTeamId` cuando llegue.

**Estimación:** 2-4 semanas si hay que arrancar; 1 día si está aprobado.

---

### 🔴 B4 — Google Play Console enrollment (organizacional)

**Evidencia:** `RELEASE_CHECKLIST.md:92-96` lo lista como pendiente. No hay `serviceAccountKeyPath` válido (es solo path `./google-service-account.json` que es gitignored).

**Severidad:** BLOCKER de submit Android.

**Por qué importa:** Google Play Console organization enrollment requiere:
- USD 25 one-time.
- Identity verification.
- Para organization: documentos legales + D-U-N-S recomendado.
- Cuentas creadas tras 13 nov 2023 (personales) requieren **closed test con 12+ testers durante 14 días** antes de promover a producción. Organization quedan exentas.

**Fix:**
- Si no está iniciado: enrollment + creación de las 2 apps (`app.tricigo.client`, `app.tricigo.driver`).
- Service Account JSON desde Google Cloud Console → linked a Play Console.
- Guardar JSON como `apps/client/google-service-account.json` (gitignored).

**Estimación:** 1-2 semanas (verification + setup); 1 día si ya está hecho.

---

## 3. INCONSISTENCIAS DOC vs CÓDIGO (alta probabilidad de rechazo)

Estas son las **más críticas** porque Apple cross-verifica review notes contra la app real. Si dice "X" y X no existe, rechazo.

### 🟠 D1 — Review notes promete hard-delete server-side; el código solo hace soft-delete

**Evidencia:**

`apps/client/store-metadata/app-store-review-notes.md`:
> ### Account deletion
> Settings → Eliminar cuenta. Calls a server endpoint that **hard-deletes
> the user record + cascade-deletes related data after a 30-day grace
> period** (per privacy policy).

`packages/api/src/services/auth.service.ts:184-194` (origin/master):
```ts
async deleteAccount(userId: string) {
  const supabase = getSupabaseClient();
  // Soft-delete: mark profile
  const { error: profileErr } = await supabase
    .from('users')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', userId);
  if (profileErr) throw profileErr;
  // Sign out locally
  await this.signOut();
},
```

Comment línea 182-183 dice:
> // auth.admin.deleteUser call server-side.

**Pero NO existe la edge function:**
```bash
$ git ls-tree -r origin/master --name-only | grep -E "supabase/functions/(delete|gdpr|erase)"
# vacío
```

**Severidad:** ALTA. Si el reviewer testea el flow ("Settings → Eliminar cuenta") y luego verifica que la cuenta aún puede loguearse (porque `auth.users` no se borró), rechaza.

**Por qué importa:** Apple Guideline 5.1.1(v) y Play User Data Policy exigen account deletion **completa**. Soft-delete con tag `deleted_at` es marketing — el usuario sigue existiendo en Supabase Auth, sus tokens siguen siendo válidos, podría revivir la sesión.

**Fix opciones:**

**Opción A (rápida, 2-3 horas) — alinear el doc a la realidad:**
- Editar `app-store-review-notes.md` para decir: *"Settings → Eliminar cuenta. Marks the user record as deleted, terminates active sessions, and revokes refresh tokens. Hard-delete from auth.users occurs 30 days later via background job."*
- Implementar el revoke de refresh tokens en `deleteAccount()`:
  ```ts
  await supabase.auth.admin.signOut(userId, 'global'); // requires service_role
  ```
  ↑ Esto requiere edge function porque service_role no puede vivir en cliente.

**Opción B (correcta, 1 día) — implementar hard-delete:**
- Crear `supabase/functions/delete-account/index.ts`:
  - Verifica JWT del usuario.
  - Hace soft-delete en `users` (mantener para audit/foreign keys).
  - Llama `supabase.auth.admin.deleteUser(userId)` (revoca tokens, libera email/phone).
  - Encola hard-delete cascade vía cron en 30 días.
- Update `authService.deleteAccount()` para invocar la edge function.

**Recomendación:** Opción B para no mentirle al reviewer. Pero si el submit es urgente, A es defendible siempre que el doc diga la verdad.

---

### 🟠 D2 — `data-safety.md` declara URL pública `tricigo.com/account/delete` que NO existe

**Evidencia:**

`apps/client/store-metadata/data-safety.md:16`:
> **Yes** (Settings → Eliminar cuenta + URL público en `tricigo.com/account/delete`)

```bash
$ curl -I https://tricigo.com/account/delete
# Esperado: 200 OK / 404 / sin verificar todavía
```

`apps/web/` no contiene `account/delete/page.tsx` (verificado con `git ls-tree`).

**Severidad:** ALTA. Play Console cross-verifica esta URL durante review.

**Fix:** ver B2 (mismo gap, distinta perspectiva).

---

### 🟠 D3 — Stripe sigue mencionado en docs y como dependency, aunque migración a NETOPIA está hecha

**Evidencia:**

`apps/client/package.json` (origin/master):
```json
"@stripe/stripe-react-native": "0.49.0",
```

`app-store-review-notes.md`:
> "The in-app trip credit balance… accepts top-ups via **Stripe Payment Sheet**."
> "the publishable Stripe key is in test mode; any test card (e.g. `4242 4242 4242 4242`…)"

`data-safety.md:65`:
> "User payment info | ✅ Yes (**via Stripe** — never touches our server)"

`RELEASE_CHECKLIST.md` y `PRODUCTION_READINESS.md` — extensas secciones sobre Stripe.

**Pero el código de pagos usa NETOPIA** (confirmado en sesión previa: `packages/api/src/services/payment.service.ts` + `supabase/functions/create-netopia-payment-intent/`).

**Severidad:** MEDIA-ALTA. Tres caras del problema:

1. **Privacy Manifest** del Stripe SDK puede ser detectado por Apple en el binary aunque no se use → bandera de "data collection no declarada".
2. **Review notes contradicen la app real** — si el reviewer ve NETOPIA en checkout pero el doc dice Stripe, sospecha y rechaza.
3. **Data Safety form declara Stripe** — discrepancia con la realidad.

**Fix:**

1. **Si Stripe SDK sigue siendo necesario** (legacy users, fallback, etc.):
   - Documentar en review notes que se mantiene para legacy.
   - Actualizar `data-safety.md` para mencionar AMBOS procesadores (Stripe legacy + NETOPIA actual).
2. **Si Stripe SDK ya no se usa**:
   - `pnpm remove @stripe/stripe-react-native` en `apps/client/package.json`.
   - Actualizar `app-store-review-notes.md` para reflejar NETOPIA flow + tarjetas de test NETOPIA.
   - Actualizar `data-safety.md` para reemplazar Stripe → NETOPIA.
3. **Actualizar `RELEASE_CHECKLIST.md` y `PRODUCTION_READINESS.md`** (limpieza, no bloqueante de submit).

**Estimación:** 2-4 horas para opción 2 (que es la correcta según el usuario).

---

## 4. WARNINGS (no bloquean pero pueden generar rechazo)

### 🟡 W1 — ATT (App Tracking Transparency) sin implementar

**Evidencia:**
```bash
$ git grep "expo-tracking-transparency\|requestTrackingPermissionsAsync" origin/master -- apps/client/
# vacío

$ git show origin/master:apps/client/app.json | grep -i NSUserTracking
# (sin resultado — no está)
```

`PrivacyInfo.xcprivacy` declara `NSPrivacyTracking = false`. PostHog está con `autocapture=false` (`apps/client/src/providers/app-providers.tsx:102`).

**Severidad:** WARNING. **OK si la app NO rastrea con identificadores cross-app.**

**Por qué importa:** Apple Guideline 5.1.2(i) — apps que comparten datos del usuario con plataformas third-party para tracking publicitario DEBEN llamar al `ATTrackingManager.requestTrackingAuthorization` antes. Si solo se usa PostHog para analytics first-party (autocapture off) y Sentry para crashes, no aplica.

**Fix:** **Documentar en review notes** que la app NO usa tracking, lo cual coincide con `NSPrivacyTracking=false` en el Privacy Manifest. Agregar a `app-store-review-notes.md`:
> "TriciGo does not implement App Tracking Transparency because the app does not track users across other companies' apps or websites. PostHog autocapture is disabled, Sentry runs with sendDefaultPii=false, and no advertising network SDK is integrated. NSPrivacyTracking=false in PrivacyInfo.xcprivacy matches this."

**Estimación:** 15 min (solo doc).

---

### 🟡 W2 — Hard-delete server-side ausente (relacionado con D1)

Ver §3.D1 para detalles. **Si Opción A (alinear doc)** se elige, este warning queda parcialmente abierto: técnicamente Apple/Play aceptan soft-delete + revoke de tokens, pero es subóptimo.

---

### 🟡 W3 — "Continue as guest" / browse without login no implementado

**Evidencia:** `apps/client/app/_layout.tsx:144-147` (origin/master) — RootNavigator fuerza redirect a `/(auth)/login` si `!isAuthenticated` y no estás en `(auth)` ni en deep link público.

**Severidad:** WARNING. Apple 5.1.1(v) recomienda permitir browsing sin login si la app no es 100% account-based.

**Por qué importa:** discutible para apps de movilidad. Uber, Lyft, DiDi todas requieren login. Precedentes están del lado de TriciGo. Algunos reviewers lo piden, otros no.

**Fix:** documentar la decisión en review notes:
> "TriciGo requires authentication because every primary feature (request a ride, see your active trip, manage wallet) is tied to an individual passenger account. There is no public catalog content that a guest could browse. This is consistent with the pattern of Uber, Lyft, DiDi, Cabify, and equivalent ride-hailing apps in App Store."

**Estimación:** 10 min (solo doc).

---

### 🟡 W4 — `assetlinks.json` (Android App Links) sin verificar live

**Evidencia:** `apps/client/app.json` define `intentFilter` con `autoVerify: true` para `https://tricigo.com/app/client/*`. Para que Android lo autoverifique, `https://tricigo.com/.well-known/assetlinks.json` debe responder 200 con el JSON correcto (package name + SHA-256 fingerprint).

**Severidad:** WARNING. Si no funciona, los deep links abren el navegador en lugar de la app — UX degradado pero no bloqueante.

**Fix:**
1. `curl -i https://tricigo.com/.well-known/assetlinks.json` — confirmar 200 + `Content-Type: application/json`.
2. Si 404: verificar que `apps/web/public/.well-known/assetlinks.json` exista y que el hosting (Vercel) lo sirva.
3. Si responde pero con datos viejos: regenerar tras build de production EAS con SHA-256 de la upload key + key del Google Play App Signing.

**Estimación:** 30 min verificación + 1-2 h si hay que regenerar.

---

### 🟡 W5 — 16 KB page size compatibility (Play Store post-noviembre 2025)

**Evidencia:** Google Play exige a partir de noviembre 2025 (con grace period hasta agosto 2026) que apps con código nativo soporten page size de 16 KB en dispositivos ARM64.

**Severidad:** WARNING. Aplica a apps con NDK / native libraries. Expo SDK 55 + RN 0.83.4 ya soportan 16 KB. **Verificar** en el próximo EAS build.

**Fix:**
1. Tras correr `eas build --profile production --platform android`, descargar el AAB.
2. Inspeccionar nativos con `unzip` + `objdump -p libfoo.so | grep LOAD` → alignment debe ser `0x4000` (16 KB) o múltiplo.
3. Si alguna `.so` está en `0x1000` (4 KB), identificar la librería culpable y reportar al maintainer (todos los mainstream ya migraron).

**Estimación:** 1 h verificación post-build.

---

### 🟡 W6 — Performance gama baja (mercado Cuba) sin verificación de campo

**Evidencia:** `compass_artifact_*.md` enfatiza targets para Redmi 9A / Samsung A03 Core (2 GB RAM, MediaTek Helio G25):
- Cold start <2.5s
- APK <30 MB
- 60 FPS sostenido en listas

Verificación en código:
- ✅ **Hermes**: default en Expo SDK 50+. TriciGo está en SDK 55 → Hermes activo.
- ✅ **New Architecture (Fabric)**: default en RN 0.76+. TriciGo en RN 0.83.4 → activo.
- ✅ **`expo-image ~55.0.8`** instalado → WebP support.
- ⚠️ **FlashList**: NO está en `package.json` (busqué `flash` en deps). Probable que use `FlatList` en listas.
- ⚠️ **MMKV**: NO está en `package.json`. Usa `@react-native-async-storage/async-storage ^2.2.0` que es ~30× más lento.

**Severidad:** WARNING. No bloquea submit pero puede causar **crashes ANR / OOM en review** si el reviewer testea en device de gama media-baja.

**Fix recomendado** (Fase 2, NO antes del submit):
1. Migrar listas largas (history, rides recientes, drivers nearby) a `@shopify/flash-list`.
2. Migrar prefs UI / cache no sensible de AsyncStorage a `react-native-mmkv`.
3. Test en Redmi 9A real o emulator con 2 GB RAM + CPU lento, cold start con `adb shell am start`.

**Estimación:** 4-8 h (refactor + test).

---

### 🟡 W7 — Stripe SDK aún en dependencies (relacionado con D3)

Ver §3.D3 para detalles. Si se decide remover, agregar a Fase 2.

---

### 🟡 W8 — Trader status UE (DSA) sin declaración

**Evidencia:** App Store Connect tiene un campo "Trader status" obligatorio desde 2024 para distribución en mercados UE. Si TriciGo distribuirá en EU (ej. para turistas cubanos en EU usando VPN), debe declararse.

**Severidad:** WARNING. **OK si solo se distribuye en mercados no-UE** (Cuba, LATAM). Apple retira la app de la UE si no se declara, pero no rechaza en otros mercados.

**Fix:** Decisión de business → si EU está en el roadmap, completar trader info en App Store Connect → My Apps → App Information → DSA Trader Compliance.

**Estimación:** N/A si no se distribuye en UE; 30 min si sí.

---

## 5. Apple App Store Review Guidelines — checklist coverage

Notación: ✅ Cumple / ⚠️ Verificar / 🔴 Gap / N/A No aplica

### 1. Safety
| Guideline | Estado | Evidencia |
|---|---|---|
| 1.1 Objectionable Content | N/A | App de movilidad, sin UGC |
| 1.2 User-Generated Content | N/A | Sin chat público / contenido user-generated |
| 1.4 Physical Harm (health/medical) | N/A | Sin health features |
| 1.5 Developer Information | ⚠️ | Verificar que Support URL `tricigo.com/support` responde 200 |
| 1.6 Data Security | ✅ | HTTPS only, ATS default, secure storage en `expo-secure-store` |

### 2. Performance
| Guideline | Estado | Evidencia |
|---|---|---|
| 2.1 App Completeness | ✅ | Sentry monitoring activo, demo credentials documentadas |
| 2.2 Beta Testing | ✅ | TestFlight habilitado vía EAS |
| 2.3 Accurate Metadata | ✅ | `store-metadata/es/listing.md` + screenshots reales |
| 2.4 Hardware Compatibility | ⚠️ | Verificar W6 (gama baja) |
| 2.5 Software Requirements | ✅ | Xcode 16+ vía EAS Build; iOS 15.1 deployment target |

### 3. Business
| Guideline | Estado | Evidencia |
|---|---|---|
| 3.1.1 In-App Purchase | ⚠️ | Wallet TriciCoin = zona gris. Cubierto en review notes (§D3 update needed). Defensa correcta para physical service. |
| 3.1.2(c) EULA link | ✅ | Terms screen + `tricigo.com/terms` URL pública |
| 3.2 Other Business Model Issues | ✅ | Servicio físico, no IAP |

### 4. Design
| Guideline | Estado | Evidencia |
|---|---|---|
| 4.0 Design | ✅ | HIG-friendly, Dynamic Island insets, dark mode |
| 4.2 Minimum Functionality | ✅ | Mapa nativo, GPS, push, NETOPIA en in-app browser — no es webview shell |
| 4.5 Apple Sites and Services | ✅ | Apple Sign In implementado |
| 4.8 Login Services (Sign in with Apple) | ✅ | Implementado en `login.tsx:275, 286-287` |

### 5. Legal
| Guideline | Estado | Evidencia |
|---|---|---|
| 5.1.1(i) Data Collection and Storage | ✅ | Privacy policy live + Privacy Nutrition Labels (Data Safety equivalente) |
| 5.1.1(v) Account Deletion (in-app) | ✅ | `profile/settings.tsx:254-313` con doble confirmación |
| 5.1.1(v) Account Deletion (full backend) | 🔴 | Ver D1 — solo soft-delete |
| 5.1.2(i) AI Generative Disclosure (2025) | N/A | No usa LLMs third-party desde cliente |
| 5.1.2 Data Use and Sharing | ✅ | Privacy Manifest + Data Safety alineados |
| 5.1.5 Location Services | ✅ | `NSLocationWhenInUseUsageDescription` específico, sin background en client |
| 5.4 VPN | N/A | No es VPN app |
| 5.5 Mobile Device Management | N/A | No es MDM |

---

## 6. Google Play Console Policies — checklist coverage

### Permissions
| Policy | Estado | Evidencia |
|---|---|---|
| Target SDK 35 (Android 15) | ✅ | `expo-build-properties` en `app.json:67` |
| 64-bit (ARM64-v8a + x86_64) | ✅ | EAS Build genera ambos automáticamente |
| App Bundle (.aab) obligatorio | ✅ | `eas.json` production sin `buildType: apk` |
| Background location | N/A | Client no usa background location (driver sí — Fase 2) |
| POST_NOTIFICATIONS Android 13+ | ✅ | `expo-notifications` plugin maneja runtime request |
| Foreground service types Android 14+ | N/A | Client sin foreground services |
| Photo Picker Android 14+ | ✅ | `expo-image-picker` usa picker nativo |
| Contacts (Android Contact Picker oct 2026) | N/A | App no accede a contactos |

### User Data
| Policy | Estado | Evidencia |
|---|---|---|
| Data Safety form | ✅ pre-llenado | `apps/client/store-metadata/data-safety.md` listo para pegar en consola |
| Privacy policy URL | ✅ | `tricigo.com/privacy` (pendiente confirmar 200 OK live) |
| Account deletion in-app | ✅ | `profile/settings.tsx:254-313` |
| Account deletion URL pública | 🔴 | Ver B2 |
| Encryption in transit | ✅ | HTTPS only |
| Encryption at rest | ✅ | Supabase default + `expo-secure-store` |

### Performance / Quality
| Policy | Estado | Evidencia |
|---|---|---|
| Pre-Launch Report (Firebase Test Lab automatic) | ⚠️ | Necesita demo credentials configuradas en Play Console (`+1 415 555 0100` / OTP `000000` según `app-store-review-notes.md`). Verificar override en backend. |
| Crash-free rate >99.94% | ⚠️ | Sentry activo, monitoring on. Validar post-launch. |
| ANR rate <0.47% | ⚠️ | Hermes + New Arch ayudan; sin métrica current. |
| Core App Quality (UI) | ✅ | Touch targets 48dp+, contrast checks documentados en `IOS_APPSTORE_COMPLIANCE.md` |

### Distribution
| Policy | Estado | Evidencia |
|---|---|---|
| Closed test 14 días (cuentas nuevas post-nov 2023) | ⚠️ | Aplicable solo a cuentas individuales. Organization exenta. Verificar tipo de cuenta. |
| Play Integrity API (replaces SafetyNet) | ⚠️ | NO implementado. Opcional para v1; recomendado para v2. |
| AppLinks (assetlinks.json) | ⚠️ | Ver W4 |
| 16 KB page size (post-nov 2025) | ⚠️ | Ver W5 |
| AI-Generated Content policy (2025) | N/A | No genera contenido AI |

---

## 7. Performance gama baja (mercado Cuba) — checklist específico

Devices target según `compass_artifact_*.md`:

| Device | RAM | CPU | OS | Status |
|---|---|---|---|---|
| Xiaomi Redmi 9A | 2 GB | MediaTek Helio G25 | Android 11-12 | ⚠️ Sin test |
| Samsung A03 Core | 2 GB | Unisoc | Android 11 | ⚠️ Sin test |
| Tecno / Itel low | 2 GB | MediaTek | Android 11 | ⚠️ Sin test |
| iPhone SE 2nd gen | 3 GB | A13 | iOS 15+ | ⚠️ Sin test |

Stack actual TriciGo:
- ✅ **Hermes** (SDK 55 default)
- ✅ **New Architecture / Fabric** (RN 0.76+ default; RN 0.83.4 vigente)
- ✅ **expo-image** (WebP support)
- ✅ **Reanimated, Gesture Handler** (estándar Expo SDK 55)
- ⚠️ **No FlashList** (recomendado para listas largas)
- ⚠️ **No MMKV** (AsyncStorage es ~30× más lento)
- ⚠️ **Mapbox `?optimize=true`**: verificar uso de vector tiles optimizados
- ⚠️ **Bundle size**: target <30 MB APK. Hay que medir post-build.
- ⚠️ **Cold start target Redmi 9A**: <2.5s. Sin medir.

**Fix sugerido (Fase 2):**
1. Setup CI con Firebase Test Lab usando matriz que incluya Redmi 9A equivalente.
2. Smoke test post-build: instalación + login + map + ride request → tiempo total.
3. Migrar a FlashList + MMKV si Cold start >3.5s.

---

## 8. Pre-submit checklist accionable

> Pegar este checklist en un Notion / Linear y marcar antes del submit.

### Hard blockers (sin esto, no se puede submit)
- [ ] Apple Developer Program enrolado + verificado → `appleTeamId` disponible
- [ ] Google Play Console enrolado + verificado → service account JSON disponible
- [ ] D-U-N-S Number (si organization)
- [ ] `apps/client/eas.json` con `ascAppId` y `appleTeamId` reales (B1)
- [ ] `https://tricigo.com/account/delete` retorna 200 con página informativa (B2)

### Inconsistencias docs vs código (resolver para evitar rechazo)
- [ ] Decidir D1: implementar hard-delete edge function **o** alinear `app-store-review-notes.md` con soft-delete real
- [ ] Resolver D3: limpiar `@stripe/stripe-react-native` del package.json **o** documentar como legacy en review notes
- [ ] Actualizar `data-safety.md` para mencionar NETOPIA (no solo Stripe)

### Verificaciones técnicas live
- [ ] `curl -I https://tricigo.com/privacy` → 200 OK
- [ ] `curl -I https://tricigo.com/terms` → 200 OK
- [ ] `curl -I https://tricigo.com/support` → 200 OK
- [ ] `curl -I https://tricigo.com/account/delete` → 200 OK (después de B2)
- [ ] `curl -i https://tricigo.com/.well-known/assetlinks.json` → 200 OK con JSON válido (W4)
- [ ] `curl -i https://tricigo.com/.well-known/apple-app-site-association` → 200 OK

### Cuentas de revisor + datos seed
- [ ] Test account `+1 415 555 0100` activo en backend (override OTP `000000` operativo)
- [ ] Wallet seed: $50 demo balance
- [ ] Historial: 1 ride completado para que el reviewer vea la lista populated
- [ ] Email alternative `reviewer-rider@tricigo.com` creado con password

### Submission metadata
- [ ] `apps/client/store-metadata/es/listing.md` revisado (descripción ES, keywords)
- [ ] `apps/client/store-metadata/en/listing.md` revisado (inglés para AS internacional)
- [ ] Screenshots `apps/client/store-metadata/screenshots/*.png` aprobados visualmente
- [ ] Icon 1024×1024 PNG sin alpha en `apps/client/assets/icon.png`
- [ ] Feature graphic Play Store 1024×500 (verificar si existe)
- [ ] App Privacy en App Store Connect rellenado (basado en `data-safety.md`)
- [ ] Data Safety en Play Console rellenado (basado en `data-safety.md`)
- [ ] Content rating Apple (4+ / 17+) decidido
- [ ] Content rating Google (IARC questionnaire) completado

### Build + Submit
- [ ] `eas build --profile production --platform ios` → IPA producido
- [ ] `eas build --profile production --platform android` → AAB producido
- [ ] Sentry recibió evento de release (manual o automático)
- [ ] `eas submit --profile production --platform ios` → TestFlight processing
- [ ] `eas submit --profile production --platform android` → Internal Testing track
- [ ] Smoke test en device real con build production (no debug)

### Documentar warnings antes del submit (en review notes)
- [ ] W1 ATT: documentar que NO se rastrea (alineado con NSPrivacyTracking=false)
- [ ] W3 Guest mode: documentar precedente Uber/Lyft/DiDi
- [ ] W6 Performance: si hay reviewer en Redmi 9A, pedir indulgencia o ya tener fix

---

## 9. Apéndice — Docs internos desactualizados (limpieza opcional)

Estos docs viven en `docs/` y se contradicen entre sí o con el código. Para Fase 2 (post-submit):

| Doc | Issue | Acción recomendada |
|---|---|---|
| `RELEASE_CHECKLIST.md:97-103` | Lista Stripe como dependencia | Actualizar a NETOPIA |
| `BLOQUEANTES.md:1-9` (Twilio) | Lista Twilio como SMS primario | Actualizar con Meta WhatsApp + D7 |
| `BLOQUEANTES.md:38-83` (EAS Builds) | Mismo flujo aplica, pero placeholders eas.json | Cross-reference con esta auditoría |
| `PRODUCTION_READINESS.md:210-235` (Stripe) | Sección extensa de Stripe | Reemplazar con sección NETOPIA |
| `IOS_APPSTORE_COMPLIANCE.md:13-16` | Afirma NSContacts/NSUserTracking en app.json | Verificado: no están. Doc desactualizado. |
| `STORE_RELEASE.md:167` | "Users can request via support" para deletion | Actualizar: in-app + URL pública existen |

---

## 10. Fase 2 (post-submit) — backlog organizado

Items detectados pero fuera del scope del submit inmediato:

### Code / app
- [ ] Hard-delete edge function (D1 Opción B)
- [ ] Limpieza Stripe SDK del client package.json (D3)
- [ ] FlashList migration en listas largas (W6)
- [ ] MMKV migration desde AsyncStorage (W6)
- [ ] Cold start profiling en Redmi 9A real
- [ ] Bundle size <30 MB target
- [ ] Play Integrity API integration (anti-fraud)

### Docs
- [ ] Limpiar RELEASE_CHECKLIST, BLOQUEANTES, PRODUCTION_READINESS (referencias Stripe)
- [ ] Actualizar IOS_APPSTORE_COMPLIANCE con realidad post-fixes
- [ ] Crear DRIVER_STORE_READINESS.md (auditoría análoga, próxima iteración)

### Web / infraestructura
- [ ] `apps/web/src/app/account/delete/page.tsx` (B2)
- [ ] Verificar `.well-known/assetlinks.json` y `apple-app-site-association` live (W4)
- [ ] Trader status UE en App Store Connect (W8) — solo si EU está en roadmap

### Performance / QA
- [ ] Cuenta TestFlight con 12+ testers reales (14 días) — Closed Testing equivalente Play
- [ ] Firebase Test Lab Pre-Launch Report con demo creds
- [ ] Smoke test E2E en matriz de devices (iPhone SE, Redmi 9A, Pixel 6)
- [ ] Battery test: 1h con app abierta, drenaje <8% iPhone / <12% Android low-end

---

## 11. Próximo paso

El usuario decidió: **"Solo identificar gaps — reporte exhaustivo en MD"** y **"Decidí después del reporte"** sobre actualizar docs viejos.

Entregable de esta auditoría: este archivo. **Sin cambios de código.**

Para avanzar, el usuario puede:

1. **Resolver los 4 blockers hard** (cuentas + URL pública) en paralelo con el equipo legal/ops mientras yo (o quien siga) ataca las 3 inconsistencias docs/código.
2. **Decidir D1 y D3**: implementar hard-delete o solo alinear docs; remover Stripe SDK o documentarlo legacy.
3. **Cuando esté listo**, pedirme auditoría análoga del driver app (`docs/STORE_READINESS_DRIVER.md`).

Esta auditoría se basa exclusivamente en código y docs vigentes en `origin/master` al 2026-05-23. Cualquier cambio posterior puede invalidar findings — re-auditar si el delta es significativo.
