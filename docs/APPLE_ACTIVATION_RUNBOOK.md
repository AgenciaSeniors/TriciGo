# Apple — Runbook de activación (App Store)

> **Estado:** esperando que Apple active la cuenta de organización (Enrollment **T5TFT3CN5Z**, "being processed"). Hasta entonces App Store Connect devuelve `INVALIDITCUSER` y **no se puede enviar nada**.
>
> Este runbook deja todo listo para que, al activarse la cuenta, la puesta en marcha sea **mecánica** (pegar valores, no investigar). Marcado con 🔑 = el único dato que hay que pegar al final.

## 0. Datos fijos (ya conocidos)

| Dato | Valor |
|---|---|
| Entidad legal | MACH DIGITAL TECH S.R.L. (Brașov, Rumania) |
| D-U-N-S | 303159773 |
| Apple Enrollment ID | T5TFT3CN5Z |
| Apple ID de la cuenta | edua56621636@gmail.com · email del enrollment: soporte@tricigo.com |
| Autoridad legal (firma/verificación) | María Loraime González Carvajal Hernández (administradora) |
| Bundle ID — Pasajero | `app.tricigo.client` |
| Bundle ID — Conductor | `app.tricigo.driver` |
| Proyecto Supabase | `lqaufszburqvlslpcuac` · auth domain `auth.tricigo.com` |
| Supabase OAuth callback | `https://auth.tricigo.com/auth/v1/callback` |
| Redirect URLs ya en la allowlist | `tricigo://auth/callback`, `tricigo-driver://auth/callback` (verificadas) |

---

## 1. Apple Developer portal — crear identidades (developer.apple.com/account)

Al activarse la membresía:

1. **Team ID** → arriba a la derecha, "Membership details". Anotarlo. → 🔑 **TEAM_ID**
2. **App IDs** (Identifiers → +): registrar dos, marcando la capability **"Sign in with Apple"** en cada uno:
   - `app.tricigo.client`
   - `app.tricigo.driver`
3. **Services ID** (Identifiers → + → Services IDs): crear uno para el flujo OAuth web de Supabase, p. ej. `com.tricigo.signin`.
   - Habilitar "Sign in with Apple" → Configure:
     - **Primary App ID:** `app.tricigo.client`
     - **Domains:** `auth.tricigo.com`
     - **Return URLs:** `https://auth.tricigo.com/auth/v1/callback`
   - → 🔑 **SERVICES_ID** (= el "Client ID" que pide Supabase para el flujo web)
4. **Key** (Keys → +): nombre "TriciGo Sign in with Apple", habilitar **Sign in with Apple**, Primary App ID `app.tricigo.client`. Descargar el archivo **`.p8`** (solo se baja una vez).
   - → 🔑 **KEY_ID** (10 chars) + el contenido del **`.p8`**

> El código usa el flujo **OAuth web vía Supabase** (no el botón nativo `expo-apple-authentication`), así que con el **Services ID + Key** alcanza. El botón nativo es una mejora opcional posterior (requeriría también el entitlement en `app.json` + rebuild).

---

## 2. Supabase — habilitar el provider Apple

Dashboard → Authentication → Providers → **Apple** → Enable, y pegar:

- **Client IDs:** `com.tricigo.signin, app.tricigo.client, app.tricigo.driver` (el Services ID para web + los dos bundle IDs por si luego se usa el nativo)
- **Team ID:** 🔑 TEAM_ID
- **Key ID:** 🔑 KEY_ID
- **Private key:** 🔑 contenido del `.p8`

Guardar. Verificación rápida (sin dashboard) — debe pasar de 400 a 302:
```bash
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  "https://lqaufszburqvlslpcuac.supabase.co/auth/v1/authorize?provider=apple&redirect_to=tricigo%3A%2F%2Fauth%2Fcallback" \
  -H "apikey: sb_publishable_hSzDS_2ivar8CGqUm-yd3w_-65h1Zsc"
# Esperado: 302 https://appleid.apple.com/...   (hoy da: 400 "provider is not enabled")
```
Las Redirect URLs ya están allowlisted; no hay que tocar la allowlist.

---

## 3. `eas.json` — pegar los 2 ids (ambos apps)

En `apps/client/eas.json` **y** `apps/driver/eas.json`, sección `submit.production.ios`:

```jsonc
"ios": {
  "appleId": "edua56621636@gmail.com",
  "ascAppId": "FILL_ME",      // 🔑 App Store Connect App ID (numérico) — uno por app, del paso 4
  "appleTeamId": "FILL_ME"    // 🔑 TEAM_ID del paso 1 (igual para ambos apps)
}
```

---

## 4. App Store Connect — crear las 2 apps y cargar la ficha

My Apps → **+** → New App (una para cada bundle ID). Al crearlas, ASC asigna el **Apple ID numérico** de cada app → ese es el 🔑 **ascAppId** del paso 3 (distinto por app).

### Metadata — Pasajero (`app.tricigo.client`)

- **Name:** `TriciGo`
- **Subtitle (≤30):** `Pide tu viaje en la ciudad`
- **Primary category:** Travel · **Secondary:** Navigation
- **Keywords (≤100):** `taxi,transporte,triciclo,electrico,moto,movilidad,conductor,viaje,ciudad,Cuba`
- **Support URL:** `https://tricigo.com` · **Marketing URL:** `https://tricigo.com`
- **Promotional text (≤170):** `Pide un triciclo, moto o auto desde tu teléfono. Precio claro antes de viajar, conductor verificado y seguimiento en tiempo real.`
- **Description:** usar el cuerpo de `apps/client/store-metadata/es/listing.md` (es) / `en/listing.md` (en).
- **Privacy Policy URL:** `https://tricigo.com/privacy`

### Metadata — Conductor (`app.tricigo.driver`)

- **Name:** `TriciGo Conductor`
- **Subtitle (≤30):** `Maneja y genera ingresos`
- **Primary category:** Travel · **Secondary:** Business
- **Keywords (≤100):** `conductor,taxi,transporte,ganancias,triciclo,electrico,moto,viaje,trabajo,Cuba`
- **Support URL:** `https://tricigo.com` · **Marketing URL:** `https://tricigo.com`
- **Promotional text (≤170):** `Recibí viajes cerca tuyo, navegá hasta el pasajero y administrá tus ganancias con total transparencia. Trabajá cuando quieras.`
- **Description:** usar `apps/driver/store-metadata/es|en/listing.md`.
- **Privacy Policy URL:** `https://tricigo.com/privacy`

### App Privacy (nutrition labels)
Reflejar exactamente `apps/<app>/store-metadata/data-safety.md` + `apps/<app>/PrivacyInfo.xcprivacy`. **App Tracking = No** (sin ATT). Detalle en las review notes.

### App Review Information → Notes
Pegar el contenido de `apps/<app>/store-metadata/app-store-review-notes.md`.
- **Demo principal (funciona en prod, verificado):** Pasajero `+5355550100` / `000000` · Conductor `+5355550101` / `000000` (no se envía SMS real; el código fijo se siembra server-side).
- El campo "Alternative email/password" de las notas es **opcional** — el demo phone alcanza. Si se quiere el email/password, crear `reviewer-rider@tricigo.com` / `reviewer-driver@tricigo.com` en Supabase Auth con contraseña y pegarla; si no, borrar esa línea de las notas antes de enviar.

### Screenshots
Reusar/adaptar `apps/<app>/store-metadata/screenshots/` a los tamaños que pide ASC (6.7" y 6.5" iPhone como mínimo). Las del Play Store sirven de base.

---

## 5. Build + envío iOS (EAS, en la nube — sin Mac)

```bash
# Pasajero
cd apps/client && npx eas-cli build --profile production --platform ios
npx eas-cli submit --profile production --platform ios
# Conductor
cd apps/driver && npx eas-cli build --profile production --platform ios
npx eas-cli submit --profile production --platform ios
```
EAS pedirá las credenciales de Apple (login del paso 0) y maneja certificados/perfiles automáticamente. `submit` usa `ascAppId`/`appleTeamId` del `eas.json` (paso 3).

---

## Checklist final (en orden)

- [ ] Cuenta Apple activa → **TEAM_ID** anotado
- [ ] App IDs `app.tricigo.client` + `app.tricigo.driver` con "Sign in with Apple"
- [ ] **SERVICES_ID** + **KEY_ID** + `.p8` creados
- [ ] Supabase provider Apple habilitado y verificado (302) ← pega TEAM_ID, KEY_ID, .p8, Client IDs
- [ ] `eas.json` (×2) con **ascAppId** + **appleTeamId**
- [ ] Apps creadas en ASC + metadata/keywords/privacy/notes/screenshots cargados
- [ ] Build iOS (×2) + submit
- [ ] (Opcional) crear emails reviewer o borrar esa línea de las review notes

> El login social del lado del código ya quedó listo (PR #531): botón Apple con estilo HIG y el escape en `verify-phone`. Lo único que falta para que el botón **funcione** es el paso 2 (provider en Supabase).
