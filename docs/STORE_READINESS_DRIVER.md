# Store Readiness — TriciGo Conductor (App Store + Play Store)

> **Fecha:** 2026-05-23
> **App auditada:** `apps/driver/` (TriciGo Conductor) — Bundle `app.tricigo.driver`
> **Estado del worktree:** auditoría hecha contra `origin/master` (HEAD local 4+ commits atrás; lecturas vía `git show origin/master:<path>`)
> **Procesador de pagos:** N/A — driver **no procesa pagos** in-app (cashout removido en migración `00273_remove_driver_cashout.sql`). Solo display de ganancias.
> **Timeline objetivo del usuario:** submit esta semana (mismo que client)
> **Entregable:** identificación de gaps. **Sin cambios de código.**
> **Auditoría hermana:** [`docs/STORE_READINESS_CLIENT.md`](./STORE_READINESS_CLIENT.md) — leer primero para contexto general.
>
> **Fuentes de evidencia:**
> - Lectura directa de `origin/master` vía `git show` y `git ls-tree`
> - Docs internos: `IOS_APPSTORE_COMPLIANCE.md`, `STORE_RELEASE.md`, `RELEASE_CHECKLIST.md`, `BLOQUEANTES.md`, `PRODUCTION_READINESS.md`
> - Docs externos del usuario (en `C:\Users\Eduardo\Downloads\`): `compass_artifact_*.md`, `deep-research-report.md`, `Requisitos Aprobación Tiendas Apps.md`
> - Apple Review Guidelines (2025-Q1)
> - Google Play Developer Program Policies (2025-2026) — énfasis en background location

---

## 0. Resumen ejecutivo

**Veredicto general:** **NO está listo para submit esta semana**. El driver app tiene **más complejidad regulatoria** que el client (background location + KYC docs + Google Play declaration form obligatorio), y tiene **un gap funcional crítico** (FD1) que puede causar falla técnica en Android además de problemas de compliance.

**Lo bueno (driver tiene cosas mejores que el client):**

| Item | Estado |
|---|---|
| `NSLocationAlwaysAndWhenInUseUsageDescription` con texto excelente | ✅ `app.json:26` — explica "qué cambia si denegado" como Apple recomienda |
| `UIBackgroundModes: ["location", "remote-notification"]` | ✅ |
| `expo-location` plugin con `isAndroidBackgroundLocationEnabled: true` + `isAndroidForegroundServiceEnabled: true` | ✅ |
| Permission flow correcto: foreground first, background SOLO durante ride activo | ✅ `useDriverLocation.ts:160, 173` |
| Apple Sign In + Google + SMS OTP | ✅ `login.tsx:297` |
| KYC documents flow con compresión | ✅ `onboarding/documents.tsx` |
| Account deletion in-app con doble confirmación texto "ELIMINAR" | ✅ `app/profile/settings.tsx:242-263` |
| **Cashout removido** (migración 00273) → wallet closed-loop | ✅ Cero IAP risk |
| **Driver NO procesa pagos in-app** | ✅ Zero PCI scope |
| Privacy Manifest completo con data types relevantes | ✅ `apps/driver/PrivacyInfo.xcprivacy` |
| Store metadata existente (review notes, data-safety, listings, screenshots) | ✅ `apps/driver/store-metadata/` |
| **Stripe SDK ya removido del driver package.json** | ✅ (cliente aún tiene; driver no) |
| `@rnmapbox/maps ~10.3.0` + `@sentry/react-native ^7.11.0` (Privacy Manifest compliant) | ✅ |
| Target SDK Android 35 / iOS 15.1 / Hermes / New Architecture | ✅ |
| ATS / HTTPS only, network security config, `ITSAppUsesNonExemptEncryption: false` | ✅ |
| Universal Links + Android App Links con `autoVerify` | ✅ |

**Lo malo:**

🔴 **4 BLOCKERS HARD** (§2)
🔴 **1 GAP FUNCIONAL CRÍTICO FD1** (§3) — el más importante de este reporte
🟠 **3 INCONSISTENCIAS DOC vs CÓDIGO** (§4)
🟡 **8 WARNINGS** (§5)

---

## 1. Decisión de submit

**Driver requiere más trabajo previo que client:**

| Bloqueo | Tiempo |
|---|---|
| Cuentas Apple/Google enroladas (compartidas con client) | 2-4 semanas si no están |
| `eas.json` driver con `ascAppId`+`appleTeamId` | 30 min si Apple Dev activo |
| URL pública de account deletion | 2-4 horas (puede reusarse del client) |
| **Background Location Declaration Form (Play Console)** | 4-8 horas (requiere video ≤30s + screenshots de prominent disclosure) |
| **Decisión técnica sobre FD1** | 2-3 días si se decide implementar background real; 1 hora si se documenta "foreground only" |
| Resolver 3 inconsistencias doc/código | 4-8 horas |

**Viabilidad realista:**
- **Si las cuentas YA están** y el equipo asigna 2-3 días → submit posible en 7-10 días.
- **Si las cuentas NO están** → mínimo 3-4 semanas.
- **Especialmente Google Play** rechaza ride-sharing sin Background Location Declaration Form completo + video.

---

## 2. BLOCKERS HARD

### 🔴 BD1 — `eas.json` driver con valores `FILL_ME`

**Evidencia (`apps/driver/eas.json:46-47`, origin/master):**
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

**Severidad:** BLOCKER de submit Apple. Idéntico al gap del client B1 pero con el `eas.json` separado del driver (`apps/driver/eas.json`).

**EAS Project ID** del driver: `4f32a103-ff3b-4222-b5f6-22da581f5fc5` (distinto al del client `bb3c1a52-...`).

**Fix:**
1. Crear app en App Store Connect con bundle ID `app.tricigo.driver` (separada de la del cliente).
2. Copiar `ascAppId` generado.
3. `appleTeamId` es el mismo del client (mismo Apple Developer Team).
4. Reemplazar `FILL_ME` en `apps/driver/eas.json:46-47`.

**Estimación:** 30 min si Apple Developer activo.

---

### 🔴 BD2 — URL pública de account deletion driver

**Evidencia:**
```bash
$ git ls-tree -r origin/master --name-only | grep -E "apps/web.*(conductor|driver|account.*delete)"
# vacío
```

**Severidad:** BLOCKER de review Play Store (igual que el client B2, pero los reviewers pueden esperar URL específica para driver si el data-safety form la declara separadamente).

**Fix:**
1. **Opción A (rápida):** reutilizar la misma URL `tricigo.com/account/delete` con un selector "Soy pasajero / Soy conductor" que muestre el flow apropiado.
2. **Opción B:** crear `apps/web/src/app/conductor/eliminar/page.tsx` separado.

`apps/driver/store-metadata/data-safety.md:14` declara:
> User can request deletion? | **Yes** (Settings → Eliminar cuenta)

Pero NO menciona URL pública. Si Play Console requiere URL (como con el client), agregarla.

**Estimación:** 2-4 horas (Opción A si se reusa).

---

### 🔴 BD3 — Apple Developer + Google Play Console enrollment (organizacional)

**Evidencia:** mismo gap que client B3+B4. `RELEASE_CHECKLIST.md` lo lista pendiente.

**Severidad:** BLOCKER de submit (compartido con client).

**Nota crítica de los docs externos del usuario:** la entidad legal **NO puede estar domiciliada en Cuba** (sanciones OFAC bloquean Stripe/payments y restringen Apple/Google business accounts en Cuba). Probable estructura: Delaware C-Corp, Estonia e-Residency, España o México.

**Estimación:** 2-4 semanas si hay que iniciar; 1 día si ya está aprobado.

---

### 🔴 BD4 — Background Location Declaration Form (Play Console) ausente

**Evidencia:**
- `apps/driver/store-metadata/data-safety.md:23` declara: *"Background location: yes, but only during active trips. See 'Background Location declaration form' (separate Play Console section, mandatory for ride-sharing)."*
- `apps/driver/store-metadata/` **NO contiene** `background-location-declaration-form.md` ni equivalente.

**Severidad:** BLOCKER de submit Play Store. Google **EXIGE** que aplicaciones con `ACCESS_BACKGROUND_LOCATION` completen el form **antes** de poder enviar el AAB a producción. Sin esto, ni siquiera se puede cargar el AAB.

**Por qué importa:** desde 2020 (con énfasis 2023+), Google revisa manualmente cada app que solicita background location. Requiere:

1. **Política de cumplimiento aceptada** (Play Console → App content → Sensitive app permissions).
2. **Propósito de la app** descripto con honestidad ("Ride-hailing driver app — tracks location during active trips to share with passenger").
3. **Video de demostración ≤30 segundos** (solo Android) mostrando, en este orden:
   - (a) La **prominent disclosure** in-app antes de pedir el permiso (modal explicativo con palabras "ubicación", "background"/"siempre", nombre del feature).
   - (b) El **system prompt de Android** apareciendo.
   - (c) El feature **funcionando con la app minimizada** (driver moviéndose por mapa → pasajero recibiendo updates).
4. **Cuentas demo accesibles** al reviewer.
5. **Privacy policy URL** específica explicando el uso de background location.

**Errores típicos que generan rechazo:**
- Disclosure mostrado DESPUÉS del system prompt (debe ser ANTES).
- Disclosure que no menciona literalmente "ubicación" + "background"/"siempre" + nombre del feature.
- Disclosure oculto en Settings, no en flow principal.
- Video sin la secuencia disclosure → prompt → feature.
- Demo account no funcional o sin contexto de driver.

**Fix:**
1. Crear `apps/driver/store-metadata/background-location-declaration-form.md` con:
   - Texto exacto del formulario Play Console (pre-rellenado).
   - Storyboard del video (3 escenas).
   - URL del video subido (YouTube unlisted o similar).
   - Capturas del prominent disclosure modal.
2. **Si NO existe el modal**, crearlo primero (ver W5 sobre Prominent Disclosure).
3. Grabar video con un device real o emulator + screen recorder.

**Estimación:** 4-8 horas (crear el modal + grabar video + redactar form).

---

## 3. GAP CRÍTICO FUNCIONAL + COMPLIANCE — FD1

> **✅ RESUELTO en PR #166** (Opción A — real background tracking via `expo-task-manager` + `Location.startLocationUpdatesAsync` con foreground service notification). Implementación en `apps/driver/src/services/locationBackgroundTask.ts` + integración en `useDriverLocation.ts`. Doc original del gap preservada abajo para referencia histórica.

### 🔴 FD1 — `useDriverLocation.ts` usa solo `watchPositionAsync`, no real background tracking

**Evidencia (`apps/driver/src/hooks/useDriverLocation.ts:241`, origin/master):**
```ts
subscriptionRef.current = await Location.watchPositionAsync(
  // ...
);
```

**Verificación adicional:**
```bash
$ git grep -nE "startLocationUpdatesAsync|TaskManager\.defineTask|stopLocationUpdatesAsync" origin/master -- 'apps/driver/**/*.ts*'
# vacío

$ git show origin/master:apps/driver/package.json | grep -E "task-manager|background-fetch"
# vacío
```

**No existen:** `Location.startLocationUpdatesAsync`, `TaskManager.defineTask`, ni dependencias `expo-task-manager` o `expo-background-fetch`.

**Por qué es crítico:**

`watchPositionAsync` es una API que requiere que la app esté en **foreground** (o equivalente foreground service) para invocar el callback de location updates. Comportamiento real:

| Plataforma | Comportamiento de `watchPositionAsync` |
|---|---|
| **iOS** con `UIBackgroundModes: ["location"]` + accuracy `BestForNavigation` | Funciona en background limitado — iOS lo mantiene activo gracias al background mode. **Probable que funcione razonablemente.** |
| **Android** sin foreground service custom (`startForegroundService` con notificación persistente) | **NO funciona en background**. El callback deja de invocarse en cuanto la app pasa a background o la pantalla se apaga. |

Para REAL background tracking en Android, expo-location requiere `Location.startLocationUpdatesAsync(taskName, options)` que internamente:
1. Registra un `TaskManager` task.
2. Inicia un foreground service con notification persistente.
3. Permite que el callback siga ejecutándose en background.

**El driver actual NO hace esto.**

**Consecuencia funcional:**
- **iOS**: pasajero VE el cab moviéndose en background (probable, gracias a UIBackgroundModes).
- **Android**: pasajero PIERDE la posición del driver cuando éste minimiza la app o bloquea la pantalla.

`apps/driver/store-metadata/app-store-review-notes.md` declara:
> *"Background location is used to stream the driver's position to the passenger so the passenger sees the cab approaching in real time."*

Esta promesa **no se cumple en Android**.

**Consecuencia de compliance:**

1. **App Store**: posible rechazo por "Performance: Beta Testing — Your app exhibited one or more bugs that would result in a poor user experience" si el reviewer testea en Android (poco probable, no es su jurisdicción) o si Apple percibe que las permissions declared no se usan funcionalmente como dice review notes.

2. **Play Console**: **MUY ALTO riesgo de rechazo**. Google revisa que las permissions declared sean usadas REALMENTE. Permission `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` sin uso real → "permission declared but not used" → rejection automático.

3. **UX real**: pasajeros pierden tracking en cuanto el driver minimiza app → pérdida de confianza → drivers desinstalan.

**Severidad:** 🔴 **CRÍTICA**. Es el gap más importante de esta auditoría.

**Opciones de fix:**

**Opción A (correcta, 2-3 días) — implementar background tracking real:**
1. `pnpm add expo-task-manager`.
2. Crear `apps/driver/src/services/locationBackgroundTask.ts`:
   ```ts
   import * as TaskManager from 'expo-task-manager';
   import * as Location from 'expo-location';

   export const LOCATION_TASK = 'tricigo-driver-location';

   TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
     if (error) { /* log */ return; }
     const { locations } = data as { locations: Location.LocationObject[] };
     // Upload con misma lógica que watchPositionAsync callback
   });
   ```
3. Update `useDriverLocation.ts` para usar:
   - `Location.startLocationUpdatesAsync(LOCATION_TASK, { accuracy, distanceInterval, foregroundService: { ... } })` al iniciar el viaje activo.
   - `Location.stopLocationUpdatesAsync(LOCATION_TASK)` al terminarlo.
4. Verificar que el foreground service notification configurada con título "TriciGo Conductor" y texto "Compartiendo ubicación con el pasajero" (obligatorio para Android 8+).

**Opción B (rápida, 1 hora) — admitir foreground only:**
1. Editar `apps/driver/app.json`:
   - Quitar `"location"` de `UIBackgroundModes` (iOS).
   - Quitar `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION`, `FOREGROUND_SERVICE` de Android permissions.
   - Quitar `NSLocationAlwaysAndWhenInUseUsageDescription` (queda solo `WhenInUse`).
2. Editar `useDriverLocation.ts:173` para NO solicitar `requestBackgroundPermissionsAsync`.
3. Editar `apps/driver/store-metadata/app-store-review-notes.md` y `data-safety.md` para reflejar "foreground only".
4. Comunicar a drivers que deben mantener la app abierta durante viajes.

**Recomendación:** **Opción A.** El driver app necesita real background tracking para que la promesa al pasajero se cumpla. La Opción B degrada UX y mantiene la integridad con compliance, pero los drivers reales no van a tener la app siempre en foreground (revisan WhatsApp, contestan llamadas, etc.).

---

## 4. INCONSISTENCIAS DOC vs CÓDIGO

### 🟠 DD1 — `app-store-review-notes.md` promete "documents removed from storage" pero el código solo hace soft-delete

**Evidencia:**

`apps/driver/store-metadata/app-store-review-notes.md`:
> ### Account deletion
> Settings → Eliminar cuenta. **Same cascade-delete pattern as the rider app, plus the driver's documents are removed from storage.**

`apps/driver/app/profile/settings.tsx:231-236` (origin/master):
```ts
.from('driver_profiles')
.update({ is_active: false, deactivated_at: new Date().toISOString() })
.eq('user_id', userId);
// ...
await authService.signOut();
router.replace('/(auth)/login');
```

**No hay:**
- `supabase.auth.admin.deleteUser()` call
- `supabase.storage.from('driver-documents').remove([...])` call
- Edge function `delete-driver-account` o equivalente
- Cron job para purgar docs post-N días

**Severidad:** ALTA. **Agravada por KYC sensitivity** — carné de identidad, licencia de conducir, foto del vehículo, selfie son datos personales sensibles que NO deberían quedar en storage indefinidamente cuando el usuario solicita eliminación.

**Fix opciones:**

**Opción A (correcta, 1-2 días) — implementar hard-delete + cleanup docs:**
- Crear edge function `supabase/functions/delete-driver-account/index.ts` que:
  1. Verifica JWT del driver.
  2. Lista documentos en `storage/driver-documents/<user_id>/` y los borra.
  3. Soft-delete en `driver_profiles` (mantener para audit FK).
  4. Llama `supabase.auth.admin.deleteUser(userId)`.
  5. Encola hard-delete cascade post-30 días.
- Update `settings.tsx` para invocar la edge function.

**Opción B (rápida) — alinear el doc:**
- Editar `app-store-review-notes.md` para decir la verdad: *"Settings → Eliminar cuenta. Driver profile is deactivated, sessions revoked, and KYC documents are scheduled for purge from storage within 30 days per privacy policy."*
- Pero **necesita backend** para cumplir la promesa de 30 días (no se puede solo cambiar el doc).

**Recomendación:** Opción A. El KYC sensitivity hace que esto sea casi-obligatorio para Apple Privacy Nutrition Labels + Play Data Safety + LGPD/GDPR.

**Estimación:** 1-2 días (edge function + cron + integration test).

---

### 🟠 DD2 — `data-safety.md` referencia "Background Location declaration form" que no existe

Ver §2.BD4 — mismo gap visto desde la perspectiva de inconsistencia documental. El doc lo promete; el archivo no existe.

---

### 🟠 DD3 — Verificación: Stripe SDK ya removido del driver ✅

A diferencia del client (que aún tiene `@stripe/stripe-react-native 0.49.0` en `package.json`), el **driver YA NO tiene Stripe SDK**. Verificado con:
```bash
$ git show origin/master:apps/driver/package.json | grep stripe
# vacío
```

**Status: OK.** No es gap. Mencionado para contraste con client.

---

## 5. WARNINGS

### 🟡 WD1 — ATT (App Tracking Transparency) no implementado

Mismo veredicto que el client W1. `apps/driver/PrivacyInfo.xcprivacy` declara `NSPrivacyTracking=false`. PostHog con `autocapture=false`. **OK si no rastrean.**

**Fix:** documentar en `app-store-review-notes.md` que la app NO usa tracking (15 min).

---

### 🟡 WD2 — KYC documents retention policy no documentada

**Evidencia:** no hay edge function ni cron que borre documentos en storage cuando el driver es inactivo o eliminó cuenta.

**Severidad:** WARNING. La privacy policy debe explicar la retention; el código debe respetarla.

**Fix:**
1. Editar `apps/web/src/app/privacy/page.tsx` para agregar sección "Documentos KYC: retención y eliminación":
   - "Los documentos subidos durante el onboarding (carné, licencia, vehículo, selfie) se almacenan cifrados en buckets privados de Supabase Storage."
   - "Si su cuenta se desactiva por inactividad (180+ días sin conexión) o por solicitud de eliminación, los documentos se purgan dentro de 30 días."
   - "Mantenemos copia de los documentos durante el período activo del driver para cumplimiento de auditorías de servicios de transporte."
2. Implementar el cron job (Fase 2 — no bloqueante de submit).

**Estimación:** 1 hora (privacy policy update); 4-8 horas (cron job).

---

### 🟡 WD3 — `assetlinks.json` para `app.tricigo.driver` verificar live

**Evidencia:** `apps/driver/app.json` define intent filter con `autoVerify: true` para `https://tricigo.com/app/driver/*`. Necesita `https://tricigo.com/.well-known/assetlinks.json` retornar 200 con SHA-256 del driver package (distinto al del client).

**Fix:**
```bash
curl -i https://tricigo.com/.well-known/assetlinks.json
```
Verificar que el JSON incluye ambos packages (`app.tricigo.client` Y `app.tricigo.driver`) con sus respectivos SHA-256.

`PRODUCTION_READINESS.md:325` menciona: *"SHA-256 fingerprints ya en assetlinks.json (`46:C4:...DB:88` para client, `95:8D:...B1:7D` para driver)"* — verificar live.

**Estimación:** 15 min.

---

### 🟡 WD4 — 16 KB page size compatibility (Play Store post-noviembre 2025)

Igual que client W5. Verificar post-build con `objdump -p` sobre las .so del AAB.

---

### 🟡 WD5 — `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION` permissions declared sin uso real

**Relacionado con FD1.** Las permissions están en `apps/driver/app.json:49-50`:
```json
"android.permission.FOREGROUND_SERVICE",
"android.permission.FOREGROUND_SERVICE_LOCATION"
```

Pero el código nunca llama `startForegroundService` ni usa `TaskManager` (ver FD1). Esto puede generar:
- App Review: "Your app declares permissions that are not used at runtime" → rechazo.
- Play Console Pre-Launch Report: warning de "unused permission".

**Fix:** se resuelve junto con FD1.
- Si se implementa Opción A (real background tracking): las permissions se usan, warning desaparece.
- Si se implementa Opción B (foreground only): remover las permissions del `app.json`.

---

### 🟡 WD6 — Performance gama baja Cuba (driver es más demandante)

El driver app es más exigente que el client:
- Mapa nativo siempre activo (Mapbox).
- GPS continuo (en active ride: 1s/3m).
- Push frecuentes (ride offers cada N segundos en zonas de alta demanda).
- Cálculos de routing.

**Devices target (mercado Cuba conductor):**
- Xiaomi Redmi Note 11 (mid range — más común que el 9A entre drivers profesionales).
- Samsung Galaxy A23 / A14.
- Posibles gama baja: Tecno Spark, Itel.

**Métricas a verificar** (Fase 2):
- Cold start <2.5s en Redmi Note 11.
- Battery test: 1 hora de viaje activo + GPS continuo, drenaje **<15%** (driver más demandante que client).
- ANR rate <0.47%.
- Crash-free >99.94%.

**Severidad:** WARNING. No bloquea submit pero crítico para retención de drivers en el mercado real.

---

### 🟡 WD7 — Driver `delete-account` no borra `auth.users` ni cascade

Mismo que el client W2, agravado por KYC docs. Ver DD1 (esta es la versión warning).

---

### 🟡 WD8 — Prominent Disclosure UI antes de `requestBackgroundPermissionsAsync` no existe

**Evidencia:**
```bash
$ git grep -lnE "prominent.disclosure|BackgroundLocation.*Modal|always.in.use" origin/master -- 'apps/driver/**/*.tsx' 'apps/driver/**/*.ts'
# vacío
```

`useDriverLocation.ts:173` llama `Location.requestBackgroundPermissionsAsync()` directamente, sin un modal explicativo previo.

**Severidad:** ALTA para Play Console. Google **EXIGE** un modal in-app antes del system prompt cuando se pide `ACCESS_BACKGROUND_LOCATION`. El modal debe:
- Mostrarse ANTES del system prompt.
- Contener las palabras "ubicación" (location), "background" o "siempre" (always).
- Mencionar el nombre del feature ("seguimiento de viajes activos").
- Tener botón explícito "Permitir" o "Continuar" que dispare `requestBackgroundPermissionsAsync`.
- NO ocultarse después del primer dismiss (si el user lo skipea, mostrarlo otra vez antes del prompt).

**Fix:** crear `apps/driver/src/components/BackgroundLocationDisclosure.tsx`:
```tsx
<View>
  <Text variant="h3">Compartir tu ubicación durante el viaje</Text>
  <Text variant="body">
    TriciGo necesita acceso a tu ubicación incluso cuando la app está en
    background (icono "siempre" / "always") para que el pasajero vea tu
    posición durante el viaje activo en tiempo real. Sin esto, el pasajero
    pierde tu ubicación cuando salís de la app.
  </Text>
  <Button title="Permitir ubicación en background" onPress={onAccept} />
  <Button title="Más tarde" onPress={onSkip} variant="ghost" />
</View>
```

Mostrar este modal SOLO cuando el driver toma su primer ride (NO al login). El `onAccept` dispara `requestBackgroundPermissionsAsync`. Esto cumple con la regla de Google + alinea con el video del declaration form (BD4).

**Estimación:** 2-3 horas (modal + integration + i18n).

---

## 6. Apple App Store Review Guidelines — checklist

| Guideline | Estado | Notas |
|---|---|---|
| 1.1 Objectionable Content | N/A | App profesional para drivers |
| 1.2 User-Generated Content | N/A | Sin contenido user-generated público |
| 1.4 Physical Harm | ✅ | KYC + verificación driver implementado |
| 1.5 Developer Information | ⚠️ | Verificar Support URL live |
| 1.6 Data Security | ✅ | HTTPS, ATS, secure storage |
| 2.1 App Completeness | ⚠️ | **FD1** puede causar bug en Android background — riesgo |
| 2.3 Accurate Metadata | 🟠 | `app-store-review-notes.md` promete background tracking que no funciona en Android (DD1 + FD1) |
| 2.5 Software Requirements | ✅ | Xcode 16+ vía EAS, iOS 15.1 |
| 3.1.1 In-App Purchase | ✅ | **N/A — driver no procesa pagos in-app, cashout removido** |
| 4.0 Design | ✅ | HIG-friendly |
| 4.5 Apple Sites and Services | ✅ | Apple Sign In ✓ |
| 4.8 Login Services | ✅ | Sign in with Apple implementado |
| 5.1.1(i) Data Collection | ✅ | Privacy policy + PrivacyInfo + Data Safety alineados (salvo DD1) |
| 5.1.1(v) Account Deletion (in-app) | ✅ | UI existe con doble confirmación |
| 5.1.1(v) Account Deletion (full backend) | 🔴 | Ver DD1 — solo soft-delete + docs no se borran |
| 5.1.2 Data Use and Sharing | ✅ | KYC docs no compartidos |
| 5.1.5 Location Services | 🟠 | `NSLocationAlwaysAndWhenInUseUsageDescription` excelente, pero FD1 mengua la promesa |

---

## 7. Google Play Console Policies — checklist (énfasis background location)

### Permissions
| Policy | Estado | Notas |
|---|---|---|
| Target SDK 35 | ✅ | |
| 64-bit ARM | ✅ | |
| App Bundle (.aab) | ✅ | |
| `ACCESS_BACKGROUND_LOCATION` | 🟠 | Declared, usado solo durante ride activo. **Necesita Declaration Form** (BD4) |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION` | 🔴 | Declared pero NO USADAS funcionalmente (FD1 + WD5) |
| POST_NOTIFICATIONS Android 13+ | ✅ | `expo-notifications` plugin |
| Photo Picker Android 14+ | ✅ | `expo-image-picker` con selección granular |

### User Data
| Policy | Estado | Notas |
|---|---|---|
| Data Safety form pre-llenado | ✅ | `apps/driver/store-metadata/data-safety.md` listo |
| Privacy policy URL | ✅ | `tricigo.com/privacy` (verificar 200 OK live) |
| Account deletion in-app | ✅ | `settings.tsx:242-263` |
| Account deletion URL pública | 🔴 | Ver BD2 |
| Background location declaration form | 🔴 | Ver BD4 |
| KYC documents retention policy en privacy | 🟡 | Ver WD2 |

### Sensitive Permissions
| Policy | Estado | Notas |
|---|---|---|
| Prominent disclosure UI antes de background location | 🔴 | Ver WD8 |
| Justification clear y específica en review notes | ✅ | `app-store-review-notes.md` lo cubre |
| Background location SOLO durante use-case core | ✅ | Solo durante active ride |

### Performance / Quality
| Policy | Estado | Notas |
|---|---|---|
| Pre-Launch Report Firebase Test Lab automatic | ⚠️ | Necesita demo credentials configuradas. `+1 415 555 0101` / OTP `000000` |
| Crash-free rate >99.94% | ⚠️ | Sentry activo, monitoring on |
| ANR rate <0.47% | ⚠️ | Validar post-launch |
| Core App Quality | ✅ | Touch targets 48dp+, contrast |

---

## 8. Performance gama baja Cuba — checklist

Stack vigente driver:
- ✅ Hermes (SDK 55)
- ✅ New Architecture (RN 0.83.4)
- ✅ `expo-image` (WebP)
- ✅ `expo-location ^55.1.2` (last)
- ✅ `@rnmapbox/maps ~10.3.0`
- ⚠️ FlashList: NO instalado (lo mismo que client; usa FlatList)
- ⚠️ MMKV: NO instalado (usa `@react-native-async-storage/async-storage ^2.2.0`)
- 🔴 `expo-task-manager`: NO instalado → ver FD1

**Battery test obligatorio (Fase 2):**
- 1 hora viaje activo en Redmi Note 11 → target <15% drain
- iPhone SE 2nd gen → target <8%

---

## 9. Pre-submit checklist accionable

### Hard blockers (sin esto, no se puede submit)
- [ ] Apple Developer Program enrolado + `appleTeamId` disponible (compartido con client)
- [ ] Google Play Console enrolado + service account JSON
- [ ] App driver creada en App Store Connect con bundle ID `app.tricigo.driver`
- [ ] App driver creada en Play Console
- [ ] `apps/driver/eas.json:46-47` con `ascAppId` + `appleTeamId` reales (BD1)
- [ ] `https://tricigo.com/account/delete` retorna 200 (BD2 — puede compartirse con client)
- [ ] `apps/driver/store-metadata/background-location-declaration-form.md` creado con video URL (BD4)
- [ ] Video de declaration form grabado y subido a YouTube unlisted

### Gap funcional FD1 (decisión técnica)
- [ ] Decisión: Opción A (implementar `startLocationUpdatesAsync` + `TaskManager`) o Opción B (admitir foreground-only)
- [ ] Si Opción A: implementación de `apps/driver/src/services/locationBackgroundTask.ts` + update `useDriverLocation.ts`
- [ ] Si Opción B: limpieza de permissions + UIBackgroundModes + update docs

### Inconsistencias docs vs código
- [ ] DD1: implementar edge function `delete-driver-account` o alinear `app-store-review-notes.md`
- [ ] WD8: crear `BackgroundLocationDisclosure.tsx` modal y mostrarlo antes de `requestBackgroundPermissionsAsync`
- [ ] WD2: actualizar privacy policy con sección "KYC documents retention"

### Verificaciones live
- [ ] `curl -I https://tricigo.com/privacy` → 200 OK
- [ ] `curl -I https://tricigo.com/terms` → 200 OK
- [ ] `curl -I https://tricigo.com/account/delete` → 200 OK (después de BD2)
- [ ] `curl -i https://tricigo.com/.well-known/assetlinks.json` → 200 OK con SHA-256 del driver incluido (WD3)
- [ ] `curl -i https://tricigo.com/.well-known/apple-app-site-association` → 200 OK con `app.tricigo.driver` incluido

### Cuentas de revisor + datos seed (driver-specific)
- [ ] Test account `+1 415 555 0101` activo (override OTP `000000`)
- [ ] Cuenta pre-onboarded con: docs "approved", `is_active=true`, status `online`, vehicle válido
- [ ] 1 ride histórico completado con earnings visibles
- [ ] Email alternative `reviewer-driver@tricigo.com` con password

### Submission metadata driver
- [ ] `apps/driver/store-metadata/es/listing.md` revisado
- [ ] `apps/driver/store-metadata/en/listing.md` revisado
- [ ] Screenshots `apps/driver/store-metadata/screenshots/01-05.png` aprobados
- [ ] Icon `apps/driver/assets/icon.png` 1024×1024 PNG sin alpha
- [ ] App Privacy en App Store Connect rellenado (basado en `data-safety.md`)
- [ ] Data Safety en Play Console rellenado
- [ ] **Background Location Declaration** en Play Console submitted con video link
- [ ] Content rating Apple (probable 17+ para uso real-world)
- [ ] Content rating Google IARC completado

### Build + Submit
- [ ] `eas build --profile production --platform ios` → IPA
- [ ] `eas build --profile production --platform android` → AAB
- [ ] Bundle size <40MB target (driver más grande que client por mapa offline)
- [ ] `eas submit --profile production --platform ios`
- [ ] `eas submit --profile production --platform android` → Internal Testing first
- [ ] Smoke test driver real flow (login → go online → accept ride → drive → complete)

### Documentar en review notes
- [ ] WD1 ATT: documentar no-tracking
- [ ] FD1 (si Opción B): documentar "foreground only" explícitamente
- [ ] WD6 Performance: incluir disclaimer sobre devices gama baja si aplica

---

## 10. Apéndice — Docs internos desactualizados (limpieza Fase 2)

Mismos que client. El driver no aporta divergencias nuevas con los docs internos (todos comparten el desactualización de Stripe → NETOPIA).

---

## 11. Fase 2 (post-submit) — backlog driver-specific

### Code
- [ ] **FD1 Opción A**: implementar `expo-task-manager` + `Location.startLocationUpdatesAsync` (crítico)
- [ ] **DD1**: edge function `delete-driver-account` con cleanup de KYC docs
- [ ] **WD8**: `BackgroundLocationDisclosure` modal antes de `requestBackgroundPermissionsAsync`
- [ ] FlashList + MMKV migration (como en client)
- [ ] Battery profiling en Redmi Note 11
- [ ] Pre-Launch Report Firebase Test Lab con demo creds
- [ ] **WD2**: cron job de purga de KYC docs post-180 días inactivo

### Web / Infrastructura
- [ ] `apps/web/src/app/account/delete/page.tsx` (compartido con client)
- [ ] Privacy policy update con sección KYC retention
- [ ] Verificar assetlinks.json y AASA contienen driver bundle/SHA

### Docs
- [ ] `apps/driver/store-metadata/background-location-declaration-form.md`
- [ ] Video de declaration form (YouTube unlisted)
- [ ] Actualizar `app-store-review-notes.md` (alinear con realidad post-FD1 fix)

### Performance / QA
- [ ] TestFlight Apple + Internal Testing Play con 5-10 drivers reales
- [ ] Battery + GPS test continuo
- [ ] Pre-Launch Report sin issues
- [ ] Crash-free >99.94% sostenido

---

## 12. Comparación cross-app (client vs driver)

| Item | Client | Driver |
|---|---|---|
| Blockers hard | 4 (B1-B4) | 4 (BD1-BD4) — distintos pero superpuestos |
| Inconsistencias doc/código | 3 (D1-D3) | 3 (DD1-DD3) — DD1 más grave por KYC |
| Warnings | 5 (W1-W5) | 8 (WD1-WD8) — más complejidad regulatoria |
| **Gap funcional crítico** | 0 | **1 (FD1)** — el más importante de toda la auditoría |
| IAP risk | Bajo (wallet defense en review notes) | **Cero** (cashout removido) |
| Background location | N/A | **SÍ, principal complejidad** |
| KYC docs | N/A | **SÍ, sensibilidad regulatoria** |
| Apple Sign In | ✅ | ✅ |
| PrivacyInfo.xcprivacy | ✅ | ✅ |
| Stripe SDK residual | ⚠️ Aún en deps | ✅ Removido |
| Store metadata | ✅ Completo | ✅ Completo (falta background form) |

**Lección global:** el driver es **más complejo regulatoriamente** que el client por:
1. Background location → Play Console declaration form obligatorio + prominent disclosure
2. KYC documents → retention policy obligatoria
3. FD1 → gap funcional que afecta UX real + compliance

Pero el driver **resolvió mejor** algunos gaps del client:
1. Stripe SDK ya removido
2. Cashout removido → cero IAP risk
3. No procesa pagos in-app → cero PCI scope

---

## 13. Próximo paso

**Decisión inmediata para el usuario:**

1. **Sobre FD1 (gap crítico funcional):** decidir si la app driver realmente necesita background tracking o si se va a vivir con foreground-only. Esto es **DECISIÓN DE PRODUCTO**, no solo técnica.
   - Opción A (real background): mejor UX, más esfuerzo (2-3 días).
   - Opción B (foreground only): peor UX, alineación rápida con código actual.
2. **Sobre cuentas Apple/Google:** confirmar status real (enroladas o pendientes).
3. **Sobre URL pública de account deletion:** decidir si se hace una única para client+driver o separadas.

Tras estas decisiones, esta auditoría puede convertirse en una serie de PRs específicos (1 PR por blocker/inconsistencia) en una sesión siguiente.

Esta auditoría se basa exclusivamente en código y docs vigentes en `origin/master` al 2026-05-23. Cualquier cambio posterior puede invalidar findings.
