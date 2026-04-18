# Store Release — metadata para App Store + Play Store

> Reference para completar los formularios de submission.
> Versión objetivo: 1.0.0

---

## App: **TriciGo** (cliente — passenger)

- **Bundle ID (iOS):** `app.tricigo.client`
- **Package (Android):** `app.tricigo.client`
- **EAS Project ID:** `bb3c1a52-284b-476e-8a7d-8ef5f04b465e`

### Nombre y categoría

- **Nombre:** TriciGo
- **Subtítulo iOS (30 chars):** Viajes en Cuba al instante
- **Short description Play (80 chars):** Pide tu viaje en Cuba: triciclo, moto o auto. Pago en efectivo o TriciCoin.
- **Categoría:** Viajes / Transport / Maps & Navigation

### Descripción larga (ES) — 4000 chars

```
TriciGo conecta pasajeros y conductores en toda Cuba. Pedí un viaje en triciclo,
moto, auto estándar, auto confort o mensajería — desde Pinar del Río hasta
Guantánamo, pasando por La Habana, Santa Clara, Camagüey y 14 provincias más.

POR QUÉ TRICIGO
· Precio claro antes de confirmar — sin sorpresas
· Pago en efectivo o con TriciCoin (wallet interno)
· Calificá al conductor, él te califica a vos — la confianza se construye
· Chat en la app para coordinar el encuentro sin llamar

CÓMO FUNCIONA
1. Marcá tu destino en el mapa (o escribí la dirección)
2. Elegí el tipo de vehículo
3. Confirmá el precio y esperá a que un conductor acepte
4. Seguí el viaje en tiempo real
5. Pagá al llegar y dejá tu reseña

COBERTURA
TriciGo opera en 16 provincias y 168 municipios cubanos: La Habana, Matanzas,
Villa Clara, Cienfuegos, Sancti Spíritus, Ciego de Ávila, Camagüey, Las Tunas,
Holguín, Granma, Santiago de Cuba, Guantánamo, Pinar del Río, Artemisa,
Mayabeque e Isla de la Juventud.

SEGURIDAD
· Contactos de emergencia configurables
· Compartí tu viaje con familia
· Reportá incidentes desde la app
· Disputas resueltas por el equipo TriciGo
```

### Keywords (App Store, 100 chars total)

`tricigo, viajes, cuba, habana, triciclo, moto taxi, auto, transporte, ride, movilidad`

### Screenshots requeridos

**iOS — iPhone 6.7":** 5 imágenes @ 1290×2796
1. Home con mapa + tipos de vehículo
2. Búsqueda de destino + tarifa estimada
3. Viaje en progreso — seguimiento del conductor
4. Wallet TriciCoin con historial
5. Reseña post-viaje

**iOS — iPad 13":** 5 imágenes @ 2048×2732 (opcional pre-launch)

**Android — Phone:** 5 imágenes @ 1080×1920 mínimo
- Mismos 5 shots que iOS

### URLs requeridas

- **Privacy Policy:** https://tricigo.com/privacy
- **Terms of Service:** https://tricigo.com/terms
- **Support URL:** https://tricigo.com/support
- **Marketing URL:** https://tricigo.com

### Clasificación de contenido

- **Edad mínima:** 17+ (recomendado por uso de mapas con ubicación real + pagos)
- **Content Rating (Google):** Everyone
- **Location access:** Required (core functionality)
- **Personal data collected:** Phone, email, name, location, payment info → referenciar privacy

---

## App: **TriciGo Conductor** (driver)

- **Bundle ID (iOS):** `app.tricigo.driver`
- **Package (Android):** `app.tricigo.driver`
- **EAS Project ID:** `4f32a103-ff3b-4222-b5f6-22da581f5fc5`

### Nombre y categoría

- **Nombre:** TriciGo Conductor
- **Subtítulo iOS:** Manejá con TriciGo en Cuba
- **Short description Play:** Aceptá viajes, ganá ingresos estables. Para conductores de triciclo, moto y auto en Cuba.
- **Categoría:** Viajes / Business / Negocios

### Descripción larga (ES) — 4000 chars

```
TriciGo Conductor es la app para conductores que quieren trabajar con TriciGo
en Cuba. Triciclos, motos, autos y mensajería — tu vehículo, tu horario, tus
ingresos.

POR QUÉ MANEJAR CON TRICIGO
· Cobrás en efectivo o en TriciCoin (se canjea por CUP)
· Ganancias claras: ves la tarifa antes de aceptar
· Navegación integrada con el mapa de Cuba
· Soporte directo desde la app — chat, incidentes, disputas
· Tu rating te da prioridad en las ofertas

QUÉ NECESITÁS
· Documento de identidad
· Licencia de conducir vigente
· Foto del vehículo y placa
· Cuenta bancaria o billetera para cobros
· Celular Android moderno con GPS

CÓMO ARRANCAR
1. Registrate y subí tus documentos
2. Nuestro equipo verifica (24-48h)
3. Prendé tu estado "en línea" y recibí ofertas de viaje
4. Aceptá, navegá, cobrá
5. Al fin del día revisá tus ganancias y retirá a tu cuenta

HERRAMIENTAS PARA CONDUCTORES
· Heatmap de zonas con más demanda en tiempo real
· Quests y bonos por metas cumplidas
· Navegación asistida automática a hotspots
· CSV de historial de viajes para tu contabilidad
· Reportes de ingresos por hora y por zona
```

### Screenshots (driver)

5 shots:
1. Home con mapa + estado "en línea" + hotspots
2. Oferta de viaje entrante con tarifa
3. Viaje en progreso con navegación
4. Wallet con ganancias del día
5. Quests / misiones activas

### URLs

Mismas que client (privacy, terms, support).

### Permisos sensibles

- **Ubicación en background:** Sí — core functionality (seguir viaje activo). Justificación: "TriciGo Conductor necesita ubicación en background para trackear viajes activos, mostrar al pasajero tu posición en tiempo real, y generar reportes de viajes."

---

## Data Safety (Google Play) — checklist

Para ambas apps:

- [x] Personal info: Nombre, Email, Phone number, User IDs → required for account, shared with backend (Supabase)
- [x] Location: Approximate + Precise → required, shared with backend for ride matching
- [x] Financial info: User payment info → required for wallet, not shared externally
- [x] App activity: Diagnostics (Sentry), Analytics (PostHog) → optional, shared with 3rd party
- [x] Device IDs: For push notifications → shared with backend
- Encryption in transit: Yes
- Encryption at rest: Yes (Supabase default)
- Data deletion: Users can request via support → referenciar privacy policy

---

## iOS Privacy Manifest (PrivacyInfo.xcprivacy)

Si Apple lo requiere en 2026 para apps 1.0, crear `apps/client/ios/PrivacyInfo.xcprivacy` y `apps/driver/ios/PrivacyInfo.xcprivacy`. Expo SDK 55 debería auto-generar, verificar post-build.

---

## Review Notes (para ambas apps)

Incluir en "Review Notes" de App Store Connect:

```
TriciGo is a ride-hailing platform for Cuba. To test:

1. Install the app
2. Sign in with Google (credentials provided) or with phone +53 5XXXXXXX
3. Grant location permission
4. Search for "Aeropuerto José Martí" in La Habana
5. Select "Triciclo básico"
6. Confirm ride — you'll see the map with searching drivers

Test account for review:
  Email: review@tricigo.com
  Password: (set before submission)

Privacy policy: https://tricigo.com/privacy
Terms: https://tricigo.com/terms

The driver app (TriciGo Conductor) is a separate companion app for drivers
registering to serve rides. Reviewers can test the same flow from the
driver's side by registering as a driver and uploading sample documents.
```

---

## Pending before submission

- [ ] Privacy policy publicada en https://tricigo.com/privacy
- [ ] Terms publicados en https://tricigo.com/terms
- [ ] Support page con email real en https://tricigo.com/support
- [ ] 5 screenshots producidos para client iOS 6.7"
- [ ] 5 screenshots producidos para driver iOS 6.7"
- [ ] 5 screenshots producidos para client Android Phone
- [ ] 5 screenshots producidos para driver Android Phone
- [ ] Test account `review@tricigo.com` creada con ride history + wallet con saldo
- [ ] Logo 1024×1024 validado (ya está en `apps/*/assets/icon.png`)
- [ ] Feature graphic 1024×500 para Play Store (ambas apps)
