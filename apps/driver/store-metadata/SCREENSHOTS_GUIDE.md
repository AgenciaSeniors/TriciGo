# Guía de Screenshots — TriciGo Conductor

## Requisitos de Google Play Store
- Mínimo 2, máximo 8 screenshots
- Resolución: 1080 x 1920 px (portrait) o 1920 x 1080 (landscape)
- Formato: PNG o JPEG (sin alpha)
- NO incluir contenido de dispositivo (bezels, marcos)

## Screenshots Recomendados (en orden)

### 1. Pantalla de bienvenida / Login
- Inicio de sesión con branding "TriciGo Conductor"
- Texto sugerido para overlay: "Tu app para conducir en La Habana"

### 2. Modo disponible (mapa)
- Mapa con toggle de disponibilidad activado
- Texto sugerido: "Actívate y recibe viajes"

### 3. Nueva solicitud de viaje
- Notificación/modal de un viaje entrante con distancia y precio
- Texto sugerido: "Recibe solicitudes cerca de ti"

### 4. Navegación hacia el pasajero
- Mapa con ruta trazada hacia el punto de recogida
- Texto sugerido: "Navega con rutas optimizadas"

### 5. Viaje en curso
- Pantalla de viaje activo con info del pasajero y destino
- Texto sugerido: "Viaje en progreso"

### 6. Panel de ganancias
- Resumen de ganancias del día/semana
- Texto sugerido: "Controla tus ganancias"

### 7. Historial de viajes
- Lista de viajes completados con detalles
- Texto sugerido: "Registro completo de viajes"

### 8. Perfil del conductor
- Perfil con foto, calificación y datos del vehículo
- Texto sugerido: "Tu perfil profesional"

## Cómo capturar
1. Corre la app en un emulador Pixel 7 (1080x2400) o dispositivo real
2. Navega a cada pantalla
3. Toma screenshot con `adb shell screencap -p /sdcard/screenshot.png`
4. O usa el botón de screenshot del emulador de Android Studio
5. Guarda en `apps/driver/store-metadata/screenshots/`

## Tip: Feature Graphic (banner)
- Dimensión: 1024 x 500 px
- Imagen horizontal que aparece arriba en Play Store
- Sugerencia: Logo conductor + bicitaxi + calle de La Habana
- Guardar como `feature-graphic.png`
