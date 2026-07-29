# Reducir el ruido de notificaciones de Sentry

> Verificado 2026-06-20. Acompaña a los cambios de código que bajan el **volumen de eventos** que TriciGo manda a Sentry. Esta guía cubre la otra mitad: **el dashboard de Sentry**, que es donde se decide cuántos eventos se convierten en *notificaciones* (emails/alertas). Esa parte NO se puede cambiar desde el repo.

## Resumen de qué hace el código (ya aplicado)

| App | Cambio |
|---|---|
| Cliente (`@sentry/react-native`) | `enabled: !__DEV__` (antes `true` → mandaba errores de desarrollo al proyecto de prod) + `ignoreErrors` + `beforeSend` compartidos. El handler "DEBUG" que mostraba un `Alert` con stack trace al usuario final quedó gateado a `__DEV__`. |
| Conductor (`@sentry/react-native`) | `ignoreErrors` + `beforeSend` compartidos. |
| Web + Admin (`@sentry/nextjs`) | `ignoreErrors` + `denyUrls` (extensiones del navegador) + `beforeSend` (incluye scrub de `Authorization`) en los 4 init (browser + nodejs + edge). `replaysOnErrorSampleRate` bajado de `1.0` a `0.3` (costo, no notificaciones). |

Fuente única de los filtros: [`packages/utils/src/sentryNoise.ts`](../packages/utils/src/sentryNoise.ts). Los patrones de red benignos (constantes en Cuba: `Network request failed`, fetch abortado, timeouts) y las deprecaciones de Expo **dejan de crear issues**. Está sincronizado con el silenciador de consola de [`setupRuntimeLogging.native.ts`](../packages/utils/src/setupRuntimeLogging.native.ts).

### Navegadores in-app (Instagram/Facebook) — agregado 2026-07-29

Instagram abre el link de la bio en su **propio WKWebView** e **inyecta un script de tracking** en `tricigo.com`. Al salir de la página (`pagehide`) ese script llama a su puente nativo, que ya fue desarmado, y tira:

```
TypeError: undefined is not an object (evaluating 'window.webkit.messageHandlers')
  at sendDataToNative      (app:///:1:1142)
  at sendPageHideMessage   (app:///:1:3712)
```

Nuestro `window.onerror` lo captura y Sentry lo archiva contra `tricigo-web` (issue real **TRICIGO-WEB-T**, visita con `utm_source=ig&…&fbclid=…` desde un iPhone). **Ninguna línea es nuestra** — `sendDataToNative`, `sendPageHideMessage` y `messageHandlers` tienen 0 apariciones en el repo. La página carga bien; el usuario no ve nada roto.

`denyUrls` **no sirve** acá: el script inyectado es inline, así que sus frames llevan la URL de nuestro propio documento. Filtrar por mensaje (`BENIGN_INAPP_BROWSER_PATTERNS`) es la única palanca.

> ⚠️ Las apps móviles **requieren rebuild de APK** para que el cambio tome efecto en los teléfonos instalados. Web/admin entran con el próximo deploy.

## Paso 1 — Diagnosticar qué te está notificando

Entrá a [sentry.io](https://sentry.io) con la org `agencia-senores`. Hay 3 proyectos: `tricigo-mobile`, `tricigo-web`, `tricigo-admin`.

En cada proyecto → pestaña **Issues**:

1. Ordená por **Events** (volumen) y por **Users** (alcance real).
2. Mirá la columna/filtro **Environment** de los issues que más aparecen:
   - **`development`** → era ruido de tus pruebas locales. El cambio `enabled: !__DEV__` del cliente lo corta de raíz. Podés archivarlos.
   - **`production`** y son de red (`Network request failed`, `AbortError`, `Failed to fetch`, timeouts) → los corta el nuevo `ignoreErrors`. Archivalos.
   - **`production`** y es un error de lógica real → ese sí hay que arreglarlo (avisame y lo investigamos).
3. Anotá los **3-5 títulos** que más te notifican. Si querés, pasámelos y armo un `ignoreErrors` a medida para los que sean benignos.

## Paso 2 — Tunear las reglas de alerta (la palanca #1)

Por defecto, Sentry crea una regla que **notifica en CADA issue nuevo**. Eso, con muchos errores distintos, es exactamente "muchas notificaciones". Para cada proyecto:

**Settings → Alerts → Alert Rules** (o **Issues → Alerts**):

1. Abrí la regla por defecto ("Send a notification for new issues" / "A new issue is created").
2. Cambiá la condición a un **umbral**, por ejemplo:
   - "The issue is seen by **more than 10 users**", o
   - "The issue is seen **more than 50 times in 1 hour**".
3. Agregá un filtro **`environment` equals `production`** para que los eventos de `development` nunca notifiquen.
4. (Opcional) Sumá un filtro `level` ≥ `error` para no notificar por `warning`/`info`.

Resultado: solo te llega lo que afecta a usuarios reales de forma repetida, no cada error transitorio.

## Paso 3 — Limpiar el inbox actual

En **Issues**, seleccioná los issues benignos que ya conocés (ruido de red, extensiones, deprecaciones) y usá **Ignore** (o **Archive → until it escalates**). Dejan de notificar y de contar contra tu cuota, pero si vuelven a dispararse fuerte, reaparecen.

## Paso 4 (opcional) — Acceso directo para ajuste fino

Si conectás un MCP/token de Sentry (read-only alcanza), puedo:
- Listar los issues exactos por volumen/environment.
- Proponer `ignoreErrors` específicos para los benignos que queden.
- Confirmar, 24-48 h después del deploy, que la tasa de issues nuevos bajó y que **ningún bug real quedó silenciado** por accidente.

## Riesgo a vigilar

`ignoreErrors` demasiado amplio puede **ocultar** un bug de red real. La lista en `sentryNoise.ts` es deliberadamente acotada a fallas de fetch/conectividad y no toca mensajes de lógica (ej. "Transaction aborted by user", "Payment timed out" NO se silencian). Revisá el dashboard tras desplegar para confirmar.
