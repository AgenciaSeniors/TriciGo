# 🛺 TriciGo

**Plataforma de movilidad urbana on-demand** — Monorepo Turborepo con apps para pasajeros, conductores y administración, respaldada por Supabase y construida en TypeScript.

---

## 📋 Descripción

TriciGo es un ecosistema multiplataforma de transporte urbano (modelo Uber/inDrive) diseñado para operar en ciudades con alta dependencia de vehículos ligeros (triciclos, mototaxis). El sistema conecta en tiempo real a **pasajeros**, **conductores** y **administradores** a través de aplicaciones dedicadas, con lógica de negocio centralizada en una base de datos PostgreSQL con seguridad de nivel empresarial.

> Construido como monorepo con **Turborepo + pnpm workspaces**, optimizado para escalar cada app de forma independiente.
>
> ---
>
> ## 🏗️ Arquitectura del Monorepo
>
> ```
> TriciGo/
> ├── apps/
> │   ├── web/        ← Landing pública (Next.js)
> │   ├── client/     ← App del pasajero (Next.js + PWA)
> │   ├── driver/     ← App del conductor (Next.js + PWA)
> │   └── admin/      ← Panel de administración (Next.js)
> ├── packages/
> │   ├── ui/         ← Design system compartido (componentes React)
> │   ├── db/         ← Cliente Supabase + tipos TypeScript generados
> │   └── config/     ← ESLint, TypeScript, Tailwind compartidos
> ├── supabase/
> │   └── migrations/ ← Migraciones SQL versionadas
> └── scripts/        ← Automatizaciones del monorepo
> ```
>
> ---
>
> ## ✨ Características Principales
>
> ### 👤 App del Pasajero (`apps/client`)
> - Solicitud de viaje con mapa interactivo
> - - Seguimiento en tiempo real del conductor (Supabase Realtime)
>   - - Historial de viajes y calificaciones
>     - - Notificaciones push
>       - - Ubicaciones guardadas (casa, trabajo, favoritos)
>         - - Soporte i18n (múltiples idiomas)
>          
>           - ### 🚗 App del Conductor (`apps/driver`)
>           - - Panel de disponibilidad on/off
>             - - Recepción y aceptación de solicitudes
>               - - Navegación de ruta al destino
>                 - - Historial de viajes y ganancias
>                   - - Sistema de calificación bidireccional
>                     - - Notificaciones push con Firebase
>                      
>                       - ### 🛠️ Panel de Administración (`apps/admin`)
>                       - - Dashboard con métricas en tiempo real
>                         - - Gestión de usuarios (pasajeros y conductores)
>                           - - Moderación de viajes y disputas
>                             - - Sistema de soporte con tickets threaded
>                               - - Reportes y auditoría de actividad
>                                 - - i18n completo (32 sprints de internacionalización)
>                                  
>                                   - ### 🌐 Landing Pública (`apps/web`)
>                                   - - Presentación del producto
>                                     - - SEO optimizado
>                                       - - Formulario de registro anticipado
>                                        
>                                         - ---
>
> ## 🛠️ Stack Tecnológico
>
> | Capa | Tecnología |
> |------|-----------|
> | Framework | Next.js 14 (App Router) |
> | Lenguaje | TypeScript (strict mode) |
> | Monorepo | Turborepo + pnpm workspaces |
> | UI | React + Tailwind CSS |
> | Base de datos | Supabase (PostgreSQL + Auth + Realtime + Storage) |
> | Notificaciones | Push Notifications (PWA) |
> | Tests unitarios | Vitest |
> | i18n | Internacionalización completa |
> | DB Functions | PLpgSQL (Edge Functions + RPCs) |
>
> ---
>
> ## 🚀 Inicio Rápido
>
> ### Prerrequisitos
> - Node.js ≥ 18
> - - pnpm ≥ 8
>   - - Cuenta Supabase
>    
>     - ### Instalación
>    
>     - ```bash
>       # 1. Clonar el repositorio
>       git clone https://github.com/AgenciaSeniors/TriciGo.git
>       cd TriciGo
>
>       # 2. Instalar dependencias
>       pnpm install
>
>       # 3. Configurar variables de entorno
>       cp .env.example .env.local
>       # Editar .env.local con tus credenciales de Supabase
>
>       # 4. Ejecutar en desarrollo
>       pnpm dev
>       ```
>
> ### Ejecutar una app específica
>
> ```bash
> pnpm --filter client dev    # App del pasajero en :3001
> pnpm --filter driver dev    # App del conductor en :3002
> pnpm --filter admin dev     # Panel admin en :3003
> pnpm --filter web dev       # Landing en :3000
> ```
>
> ---
>
> ## 🔑 Variables de Entorno
>
> ```env
> # Supabase
> NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
> NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
> SUPABASE_SERVICE_ROLE_KEY=eyJ...
>
> # App
> NEXT_PUBLIC_APP_URL=http://localhost:3000
> ```
>
> ---
>
> ## 📊 Métricas del Proyecto
>
> | Métrica | Valor |
> |---------|-------|
> | Sprints completados | 32 |
> | Apps independientes | 4 |
> | Lenguaje principal | TypeScript (89.1%) |
> | DB Functions (PLpgSQL) | 9.2% del código |
> | Commits | 34+ |
> | Contribuidores | 2 |
>
> ---
>
> ## 👤 Autor
>
> **Eduardo Daniel Pérez Ruiz**
> - 🎓 Estudiante de Ciencias de la Computación
> - - 📍 Sancti Spíritus, Cuba
>   - - 🏢 Agencia "Señores"
>     - - 📧 agenciaseniors@gmail.com
>       - - 🔗 [GitHub](https://github.com/AgenciaSeniors)
>        
>         - ---
>
> ## 📄 Licencia
>
> Proyecto privado — © 2026 TriciGo. Todos los derechos reservados.
