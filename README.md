# TriciGo

**Plataforma de movilidad urbana on-demand para Cuba** — conecta pasajeros con conductores de triciclos, motos y autos en tiempo real.

Monorepo TypeScript con apps nativas (Expo/React Native), panel admin (Next.js), landing web (Next.js) y backend serverless (Supabase).

---

## Arquitectura

```
TriciGo/
├── apps/
│   ├── client/       ← App del pasajero (Expo / React Native)
│   ├── driver/       ← App del conductor (Expo / React Native)
│   ├── admin/        ← Panel de administracion (Next.js)
│   └── web/          ← Landing publica + blog (Next.js)
├── packages/
│   ├── api/          ← Servicios Supabase (auth, ride, wallet, chat...)
│   ├── types/        ← Tipos TypeScript compartidos
│   ├── ui/           ← Design system React Native (21 componentes)
│   ├── utils/        ← Utilidades (geo, currency, fare, analytics...)
│   ├── i18n/         ← Internacionalizacion (ES/EN)
│   ├── theme/        ← Colores, tipografia, spacing, Tailwind preset
│   └── config/       ← ESLint + TSConfig compartidos
├── supabase/
│   ├── migrations/   ← 30 migraciones SQL
│   └── functions/    ← 8 Edge Functions (Deno)
└── .github/
    └── workflows/    ← CI/CD (4 workflows)
```

---

## Stack Tecnologico

| Capa | Tecnologia |
|------|-----------|
| Apps moviles | Expo SDK 52, React Native, Expo Router |
| Estilos nativos | NativeWind (Tailwind CSS for RN) |
| Apps web | Next.js 14 (App Router, standalone output) |
| Lenguaje | TypeScript (strict mode) |
| Monorepo | Turborepo + pnpm workspaces |
| Base de datos | Supabase (PostgreSQL + PostGIS + Auth + Realtime + Storage) |
| Mapas | Mapbox GL (con soporte offline) |
| Notificaciones | Expo Push Notifications |
| Pagos | TropiPay (tarjetas internacionales) |
| Error tracking | Sentry |
| Analytics | PostHog |
| Tests | Vitest (282 tests) |
| CI/CD | GitHub Actions + EAS Build |
| Deploy web | VPS Hostinger (PM2 + Nginx) |

---

## Features

### App del Pasajero (`apps/client`)

- Solicitud de viaje con mapa Mapbox interactivo
- 5 tipos de servicio: Triciclo Basico, Premium, Moto, Auto, Mensajeria
- Seguimiento del conductor en tiempo real (GPS + Realtime)
- ETA dinamico con OSRM routing
- Multi-stop: agregar hasta 3 paradas durante el viaje
- Viajes programados
- Chat in-ride con respuestas rapidas
- Wallet TriciCoin + efectivo + TropiPay + corporativo
- Propinas al conductor
- Codigos promocionales y referidos
- Surge pricing transparente con rango de tarifa
- Politica de cancelacion con preview de penalizacion
- Compartir viaje via link (share token)
- Historial de viajes con filtros y exportacion CSV
- Recibos PDF descargables
- Prediccion de destinos frecuentes (ML local)
- Vehiculos cercanos en mapa
- Ubicaciones guardadas y contacto de emergencia
- Soporte offline con cola de mutaciones
- Accesibilidad VoiceOver/TalkBack
- Deep linking (promo codes, referidos, share ride)
- SOS con reporte de emergencia

### App del Conductor (`apps/driver`)

- Onboarding multi-paso (datos, vehiculo, documentos, revision)
- Verificacion de identidad con selfie (facial recognition)
- Toggle online/offline con background location
- Solicitudes entrantes con sonido + haptics
- Ride chaining (viaje encadenado sin downtime)
- Navegacion waypoint-aware (parada por parada)
- Botones "Llegue a Parada" / "Continuar desde Parada"
- Chat in-ride con respuestas rapidas
- Pricing personalizado por km
- Dashboard de ganancias (hoy/semana/mes) con graficos
- Quests/misiones con recompensas
- Heat map de demanda en tiempo real
- Historial de viajes con filtros y exportacion
- Recibos PDF
- Calificacion bidireccional (conductor califica pasajero)
- Soporte offline con GPS buffering
- Accesibilidad VoiceOver/TalkBack

### Panel Admin (`apps/admin`)

- Dashboard con metricas en tiempo real
- Gestion de usuarios y conductores
- Verificacion de documentos con controles por documento
- Mapa en vivo de conductores activos
- Gestion de viajes con historial
- Sistema de soporte con tickets
- Deteccion de fraude y alertas
- Congelacion/descongelacion de wallets
- Configuracion de pricing rules (hora, zona)
- Gestion de surge zones
- Feature flags para A/B testing
- Codigos promocionales (CRUD)
- Cuentas corporativas (aprobacion, empleados, presupuesto)
- Blog y CMS (terminos, privacidad)
- Notificaciones push masivas
- Tasa de cambio USD/CUP
- Programa de referidos
- Logs de auditoria
- Reportes y analytics

### Landing Web (`apps/web`)

- Pagina principal del producto
- Reserva web con mapa
- Tracking de viaje por link
- Blog con SEO
- Terminos y privacidad (CMS)
- Links de referido y promo codes

---

## Inicio Rapido

### Prerrequisitos

- Node.js >= 20
- pnpm >= 9
- Cuenta Supabase con proyecto configurado
- Token Mapbox (para apps moviles)
- Expo CLI (`npx expo`)

### Instalacion

```bash
# Clonar
git clone https://github.com/AgenciaSeniors/TriciGo.git
cd TriciGo

# Instalar dependencias
pnpm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales
```

### Desarrollo

```bash
# Todas las apps
pnpm dev

# Apps individuales
pnpm dev:client    # Expo (pasajero)
pnpm dev:driver    # Expo (conductor)
pnpm dev:admin     # Next.js localhost:3000
pnpm dev:web       # Next.js localhost:3001

# Lint + typecheck
pnpm lint
pnpm check-types

# Tests
pnpm test

# Build
pnpm build

# Formato
pnpm format
```

---

## Variables de Entorno

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_JWT_SECRET=your-jwt-secret

# Expo apps
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_MAPBOX_TOKEN=pk.your-mapbox-token

# Next.js apps
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Sentry
NEXT_PUBLIC_SENTRY_DSN=your-sentry-dsn
EXPO_PUBLIC_SENTRY_DSN=your-sentry-dsn
SENTRY_AUTH_TOKEN=your-sentry-token
SENTRY_ORG=your-org

# PostHog
EXPO_PUBLIC_POSTHOG_API_KEY=your-posthog-key
NEXT_PUBLIC_POSTHOG_API_KEY=your-posthog-key
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

---

## Testing

```bash
# Ejecutar todos los tests
pnpm test

# Tests por paquete
cd packages/api && pnpm test     # 17 archivos, 282 tests
cd packages/utils && pnpm test   # 6 archivos, 180 tests
```

Estructura de tests:

```
packages/api/src/services/__tests__/
├── admin.test.ts         # Admin service (22 tests)
├── auth.test.ts          # Auth service (6 tests)
├── chat.test.ts          # Chat service (6 tests)
├── corporate.test.ts     # Corporate accounts (15 tests)
├── delivery.test.ts      # Delivery service (8 tests)
├── driver.test.ts        # Driver service (25 tests)
├── exchange-rate.test.ts # Exchange rates (6 tests)
├── fraud.test.ts         # Fraud detection (10 tests)
├── incident.test.ts      # Incidents (6 tests)
├── location.test.ts      # Location tracking (6 tests)
├── matching.test.ts      # Driver matching (8 tests)
├── notification.test.ts  # Push notifications (6 tests)
├── payment.test.ts       # Payments (8 tests)
├── referral.test.ts      # Referrals (9 tests)
├── review.test.ts        # Reviews (6 tests)
├── ride.test.ts          # Rides + waypoints (11 tests)
└── wallet.test.ts        # Wallet (8 tests)
```

---

## CI/CD

| Workflow | Trigger | Accion |
|----------|---------|--------|
| `ci.yml` | Push/PR a master | Lint + typecheck + test + Supabase migrations |
| `deploy-admin.yml` | Push a master (apps/admin o packages/) | Build + deploy admin a VPS via SSH + PM2 |
| `deploy-web.yml` | Push a master (apps/web o packages/) | Build + deploy web a VPS via SSH + PM2 |
| `eas-build.yml` | Tags `client-v*` / `driver-v*` | Build + submit via EAS (iOS/Android) |

### Deploy

- **Admin/Web**: VPS Hostinger con Next.js standalone + PM2 + Nginx
- **Client/Driver**: EAS Build (Expo Application Services) para iOS y Android
- **Database**: Supabase migrations aplicadas automaticamente en CI

---

## Base de Datos

30 migraciones SQL en `supabase/migrations/`:

| # | Migracion | Descripcion |
|---|-----------|-------------|
| 01 | initial_schema | Tablas core: users, rides, drivers, vehicles, wallet, reviews |
| 02 | fix_rls_recursion | Fix recursion en politicas RLS |
| 03 | wallet_dashboard_rpcs | RPCs para dashboard de wallet |
| 04 | feature_flags | Feature flags |
| 05 | ride_messages | Chat in-ride |
| 06 | sprint8_promo_wallet_devices | Push tokens + promos |
| 07 | sprint9_payment_pipeline | Payment intents + TropiPay |
| 08 | wallet_recharge_requests | Solicitudes de recarga |
| 09 | user_levels_p2p | Niveles de usuario |
| 10 | eligibility_cancellations | Logica de cancelacion |
| 11 | dynamic_pricing_tips | Propinas |
| 12 | score_matching | Sistema de matching por score |
| 13 | fraud_wallet_freeze | Deteccion de fraude |
| 14 | support_mensajeria | Tickets de soporte |
| 15 | v1_hardening | Hardening de seguridad RLS |
| 16 | pricing_nearby_vehicles | Vehiculos cercanos (PostGIS) |
| 17 | exchange_rate_billing | Tasa de cambio |
| 18 | driver_rate_fare | Tarifa personalizada del conductor |
| 19 | referral_rewards | Programa de referidos |
| 20 | tropipay_payment_intents | Pagos TropiPay |
| 21 | pg_cron_scheduled_jobs | Jobs programados |
| 22 | push_notification_triggers | Triggers automaticos de push |
| 23 | cancellation_preview | Preview de penalizacion |
| 24 | tropipay_direct_payment | Pago directo |
| 25 | avatar_storage | Almacenamiento de avatars |
| 26 | rider_rating | Rating del pasajero por conductor |
| 27 | corporate_accounts | Cuentas corporativas B2B |
| 28 | identity_verification | Verificacion selfie |
| 29 | ride_waypoints | Multi-stop waypoints |
| 30 | waypoint_driver_update | Update de waypoints por conductor |

### Edge Functions (8)

| Funcion | Descripcion |
|---------|-------------|
| `send-push` | Push notifications via Expo |
| `send-email` | Emails transaccionales |
| `create-tropipay-link` | Enlace de pago TropiPay |
| `process-tropipay-webhook` | Webhook de TropiPay |
| `create-ride-payment-link` | Enlace de pago de viaje |
| `verify-selfie` | Verificacion facial del conductor |
| `cancel-stale-rides` | Cancelar viajes expirados (cron) |
| `sync-exchange-rate` | Sincronizar tasa USD/CUP (cron) |

---

## Metricas

| Metrica | Valor |
|---------|-------|
| Archivos de test | 23 |
| Tests unitarios | 462+ |
| Migraciones SQL | 30 |
| Edge Functions | 8 |
| Componentes UI compartidos | 21 |
| Servicios API | 20+ |
| Idiomas | 2 (ES, EN) |
| Namespaces i18n | 5 (common, rider, driver, admin, web) |
| Tipos TypeScript | 18 archivos |
| GitHub Actions workflows | 4 |

---

## Autor

**Eduardo Daniel Perez Ruiz**
- Ciencias de la Computacion
- Sancti Spiritus, Cuba
- agenciaseniors@gmail.com
- [GitHub](https://github.com/AgenciaSeniors)

---

## Licencia

Proyecto privado. Todos los derechos reservados.
