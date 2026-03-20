# Guía de Screenshots — TriciGo (Pasajero)

## Requisitos de Google Play Store
- Mínimo 2, máximo 8 screenshots
- Resolución: 1080 x 1920 px (portrait) o 1920 x 1080 (landscape)
- Formato: PNG o JPEG (sin alpha)
- NO incluir contenido de dispositivo (bezels, marcos)

## Screenshots Recomendados (en orden)

### 1. Pantalla de bienvenida / Login
- Muestra la pantalla de inicio de sesión con el logo de TriciGo
- Texto sugerido para overlay: "Muévete por La Habana"

### 2. Mapa principal con ubicación
- La pantalla principal con el mapa abierto mostrando La Habana
- Texto sugerido: "Pide un bicitaxi al instante"

### 3. Selección de destino
- El usuario ingresando un destino o seleccionando de favoritos
- Texto sugerido: "Elige tu destino"

### 4. Confirmación de viaje con precio
- Pantalla mostrando el precio estimado y botón de confirmar
- Texto sugerido: "Precio transparente, sin sorpresas"

### 5. Seguimiento del conductor en mapa
- Mapa mostrando el conductor acercándose al pasajero
- Texto sugerido: "Sigue tu bicitaxi en tiempo real"

### 6. Viaje en curso
- Pantalla de viaje activo con ruta y tiempo estimado
- Texto sugerido: "Viaja seguro y cómodo"

### 7. Historial de viajes
- Lista de viajes anteriores con detalles
- Texto sugerido: "Tu historial siempre disponible"

### 8. Perfil / Configuración
- Pantalla de perfil del usuario
- Texto sugerido: "Tu cuenta, tu control"

## Cómo capturar
1. Corre la app en un emulador Pixel 7 (1080x2400) o dispositivo real
2. Navega a cada pantalla
3. Toma screenshot con `adb shell screencap -p /sdcard/screenshot.png`
4. O usa el botón de screenshot del emulador de Android Studio
5. Guarda en `apps/client/store-metadata/screenshots/`

## Tip: Feature Graphic (banner)
- Dimensión: 1024 x 500 px
- Imagen horizontal que aparece arriba en Play Store
- Sugerencia: Logo de TriciGo + bicitaxi + skyline de La Habana
- Guardar como `feature-graphic.png`
