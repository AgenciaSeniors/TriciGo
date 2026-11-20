# Bugs de las rondas de prueba

Registro de lo que encuentran las rondas de prueba en el emulador. Sirve para volver a probar cada bug cuando se arregla. Cómo se arma el emulador y con qué cuentas se prueba: `CLAUDE.md` § "Rondas de prueba en el emulador".

**Estados:**
- **abierto:** nadie lo está arreglando.
- **en arreglo:** hay una sesión o un PR trabajando en él (va anotado).
- **arreglado:** el PR se mergeó; falta volver a probarlo.
- **verificado:** se volvió a probar en el emulador con los pasos de su ficha y ya no pasa.
- **descartado:** no era un bug (se anota por qué).

Cada ronda empieza volviendo a probar los que están en "arreglado". Si vuelve a pasar, regresa a "abierto" con una nota.

## Resumen

| ID | App | Dónde | Qué pasa | Estado |
|---|---|---|---|---|
| R1-01 | Pasajero | Viaje completado | "★ 5.0 · 1 viajes": falta el singular | arreglado (#1215) |
| R1-02 | Pasajero | Tarjeta del conductor | La etiqueta de accesibilidad dice "plate" en inglés | arreglado (#1215) |
| R1-03 | Pasajero | Perfil | Con el teléfono en inglés, mezcla inglés y español | arreglado (#1215) |
| R1-04 | Pasajero | Elegir servicio | Atrás de Android cierra la app | arreglado (#1215) |
| R1-05 | Pasajero | Inicio → elegir servicio | Si se toca un destino antes de que la app tenga la ubicación, el origen queda vacío para siempre | arreglado (#1215) |
| R2-01 | Pasajero | Buscando conductor | En un teléfono de 360×800 dp, "Cancelar viaje" queda debajo del borde y la parte de arriba queda vacía | en arreglo (rama `fix/client-qa-round2`) |
| R2-02 | Pasajero | Buscando conductor | El diálogo de cancelar avisa de una "tarifa de cancelación" que ya no existe, y no está traducido | en arreglo (rama `fix/client-qa-round2`) |
| R2-03 | Pasajero | Buscando conductor | El primer paso del indicador sale cortado: "Buscando cond…" | en arreglo (rama `fix/client-qa-round2`) |
| R2-04 | Pasajero | Hoja de cancelar | "Sin penalización (primera cancelación del día)" también sale cuando el motivo es otro | en arreglo (rama `fix/client-qa-round2`) |
| R2-05 | Pasajero | Viaje cancelado por otro | La notificación del teléfono dice siempre "Tu conductor canceló el viaje" | en arreglo (rama `fix/client-qa-round2`) |
| R2-06 | Pasajero | Viaje con chofer | Muestra "Viaje compartido · Dejar de compartir" aunque la persona no compartió nada | abierto |
| R2-07 | Pasajero y conductor | Chat del viaje | En Android, el teclado tapa los mensajes, el campo de texto y el botón Enviar | en arreglo (rama `fix/client-qa-round2`) |
| R2-08 | Pasajero | Viaje en curso | Con Wi-Fi pero sin internet no aparece ningún aviso de "sin conexión" | abierto |
| R2-09 | Pasajero | Inicio y billetera | El mismo saldo vale $60.18 en el inicio y ≈ $60.51 en la billetera | abierto |
| R2-10 | Pasajero | Recargar | El monto muestra "20" pero "Pagar con tarjeta" sigue deshabilitado | en arreglo (rama `fix/client-qa-round2`) |
| R2-11 | Pasajero | Ajustes → elegir servicio | El método de pago predeterminado no se usa: los viajes salen en efectivo | en arreglo (rama `fix/client-qa-round2`) |
| R2-12 | Pasajero | Inicio | Con la app en inglés, el inicio sigue casi todo en español | en arreglo (rama `fix/client-qa-round2`) |
| R2-13 | Pasajero | Ajustes | Tocar "Idioma preferido" cambia el idioma al instante, sin mostrar opciones | en arreglo (rama `fix/client-qa-round2`) |
| R2-14 | Pasajero | Calificar y chat | Lector de pantalla: estrellas sin número y remitente del chat genérico | en arreglo (rama `fix/client-qa-round2`) |

## Fichas

### R1-01 · "1 viajes" en la tarjeta del conductor

- **Ronda 1, 2026-11-17.** Pantalla "Viaje completado" de la app del pasajero, viaje con QA Moto.
- **Qué pasa:** la tarjeta dice "★ 5.0 · 1 viajes".
- **Esperado:** "1 viaje" en singular, en es, en y pt.
- **Volver a probar:** completar un viaje con un chofer QA que tenga exactamente 1 viaje completado (QA Auto y QA Confort tenían 0 el 2026-11-17) y leer la tarjeta con `python scripts/qa/adb_ui.py find viaje`. Mirar también la tarjeta del conductor durante el viaje.
- **Arreglado en #1215:** `ride.driver_rides_count` y `ride.driver_profile_trips` tienen singular y plural en es, en y pt. Vale para la tarjeta durante el viaje, "Viaje completado", el perfil del conductor y la versión web del viaje activo.

### R1-02 · "plate" en inglés en la etiqueta de accesibilidad

- **Ronda 1, 2026-11-17.** Tarjeta del conductor, app del pasajero en español.
- **Qué pasa:** la descripción para lectores de pantalla es "QA Moto, ★ 5.0 · 1 viajes, 2022 Suzuki GN125 · Negro, plate QA-0141".
- **Esperado:** "placa" (o la palabra del idioma de la app).
- **Volver a probar:** con un viaje aceptado, `python scripts/qa/adb_ui.py find QA-01` y leer el `desc=`.
- **Arreglado en #1215:** la palabra sale de `ride.plate_label` ("Placa QA-0141" con la app en español).

### R1-03 · Perfil mezcla idiomas con el teléfono en inglés

- **Ronda 1, 2026-11-17.** Pestaña Perfil, con el emulador en inglés (antes de ponerlo en `es-US`).
- **Qué pasa:** "Saved locations", "ACCOUNT" y "Diamond" salen en inglés, pero "Modo oscuro" y "SEGURIDAD" salen en español.
- **Esperado:** todo en el idioma de la app.
- **Volver a probar:** con la app cerrada, poner en `en` el idioma guardado de la app, sin tocar la cuenta:
  ```
  adb root
  adb shell "sqlite3 /data/data/app.tricigo.client/databases/RKStorage \"UPDATE catalystLocalStorage SET value='en' WHERE key='tricigo_language';\""
  ```
  Abrir Perfil y hacer `python scripts/qa/adb_ui.py dump`: todo tiene que salir en inglés (ACCOUNT, SAFETY, ACTIVITY, MORE, Dark mode, Corporate, Blog). Al terminar, lo mismo con `es`.
  - No cambiar el idioma desde Ajustes: también escribe `preferred_language` en la fila de la cuenta (`apps/client/app/profile/settings.tsx`), y en las rondas la cuenta es la de María.
  - Poner el emulador en `en-US` no alcanza: la app usa el idioma que tiene guardado y solo mira el del teléfono si no hay ninguno.
- **Arreglado en #1215:** se agregaron las seis claves que faltaban en los tres idiomas (`profile.section_safety`, `section_activity`, `section_more`, `corporate`, `blog` y `dark_mode`). El inicio en inglés es otro caso (R2-12).

### R1-04 · Atrás de Android cierra la app al elegir el servicio

- **Ronda 1, 2026-11-17.** Pantalla de elegir el servicio (después de poner el destino).
- **Qué pasa:** el botón Atrás de Android cierra la app. Al volver a abrirla, el pedido sigue guardado.
- **Esperado:** volver al inicio.
- **Volver a probar:** poner un destino, llegar a la lista de servicios y `python scripts/qa/adb_ui.py key BACK`. La app tiene que seguir en primer plano (`dump` muestra `foreground: app.tricigo.client/...`).
- **Arreglado en #1215:** Atrás hace lo mismo que la ✕: vuelve al inicio y descarta el pedido. Con la búsqueda abierta, cierra solo la búsqueda; en "Elegir en el mapa", cierra el selector y vuelve a la búsqueda.

### R1-05 · Si se toca un destino antes de tener la ubicación, el origen queda vacío

- **Ronda 1, 2026-11-17.** Inicio de la app del pasajero, abierta antes de fijar el GPS del emulador: el origen quedó vacío y el mapa se fue a zoom 25,5 (todo gris).
- **Confirmado en la ronda 2:** con el GPS ya fijado, se tocó un destino reciente apenas apareció el inicio. El origen quedó en "Punto de recogida" y no se llenó nunca, ni con un geo fix nuevo con la app abierta. Esperando unos 10 s en el inicio antes de tocar, se llena bien.
- **Causa** (`apps/client/app/(tabs)/index.tsx`): la ubicación solo la busca el efecto de `IdleView`, y su limpieza cancela todo al desmontarse. Al tocar un destino, `flowStep` pasa a `selecting`, `IdleView` se desmonta y nadie vuelve a pedir la ubicación. `SelectingView` solo copia `prefetchedPickup`, que nunca se llegó a escribir. Tocar una predicción (`handleOneTapPrediction`) sí tiene un respaldo con GPS; tocar un reciente (`handleRecentTap`), no.
- **En un teléfono real:** pasa cuando el GPS tarda (arranque en frío, interior) y la persona toca rápido. También pasa después de cancelar un viaje: tocando un destino un par de minutos después de que el chofer canceló, el origen seguía vacío. Volviendo al inicio y esperando 20 s, se llenó.
- **Cómo sale la persona hoy:** tocar "Punto de recogida" → "Usar mi ubicación" lo llena. "Centrar en mi ubicación" (el botón del mapa) no lo llena.
- **Volver a probar:** hay que lograr que el GPS no tenga posición al tocar el destino. Si no, el emulador la da enseguida desde su caché y el bug puede no aparecer ni sin el arreglo.
  1. Reiniciar el emulador (`adb reboot`) para vaciar la caché, y volver a poner la zona horaria y los `adb reverse` (CLAUDE.md § "Rondas de prueba en el emulador").
  2. Antes de abrir la app, cambiar los proveedores `gps` y `network` por proveedores de prueba sin posición (sin el `appops`, `cmd location providers` falla con `SecurityException ... MOCK_LOCATION`):
     ```
     adb root
     adb shell appops set --uid 0 MOCK_LOCATION allow
     adb shell cmd location providers add-test-provider gps
     adb shell cmd location providers set-test-provider-enabled gps true
     adb shell cmd location providers add-test-provider network
     adb shell cmd location providers set-test-provider-enabled network true
     adb shell am force-stop com.google.android.gms
     ```
  3. Abrir la app y tocar un destino reciente en cuanto aparece el inicio (`wait "Hace"` y después `tap "Hace"`). El origen queda en "Punto de recogida" y el mapa no tiene que ponerse gris.
  4. Mandar la posición: `adb shell cmd location providers set-test-provider-location gps --location 23.1352,-82.3597`, y lo mismo con `network`. En unos segundos el origen tiene que llenarse solo, con el trayecto y los precios.
  5. Al terminar: `adb shell cmd location providers remove-test-provider gps` (y `network`), `adb shell appops set --uid 0 MOCK_LOCATION default` y `adb emu geo fix -82.3597 23.1352`.
- **Arreglado en #1215:** la pantalla de elegir el servicio sigue buscando la ubicación mientras el origen está vacío o en "Detectando dirección...", y lo llena cuando llega, sin pisar un origen que la persona eligió. Con un solo punto en el mapa, el encuadre ya no va al zoom 25,5. "Centrar en mi ubicación" sigue sin llenar el origen.

### R2-01 · "Cancelar viaje" queda fuera de la pantalla mientras busca

- **Ronda 2, 2026-11-17.** Pantalla "Buscando conductor cercano…", emulador de 360×800 dp (un teléfono chico).
- **Qué pasa:** la parte de arriba de la pantalla queda vacía y el botón "Cancelar viaje · 1:39" queda debajo del borde, apenas asomado. Hay que deslizar para encontrarlo. Lo único visible abajo es "¿No aparece conductor? Pide ayuda", que avisa a soporte.
- **Esperado:** el botón de cancelar a la vista sin deslizar.
- **Volver a probar:** pedir un viaje sin choferes de prueba conectados y sacar una captura (`adb_ui.py screenshot`): `dump` no sirve en esta pantalla porque la animación del radar no deja leerla.
- **Arreglo (rama `fix/client-qa-round2`):** "Cancelar viaje" quedó fijo abajo, fuera del scroll, y el mapa mide 150 dp en pantallas de menos de 860 dp de alto. Probado en el emulador de 360×800: el botón entero a la vista con "¿No aparece conductor? Pide ayuda" también visible. El espacio vacío de arriba es el mapa, que en el emulador no dibuja nada mientras busca (en el viaje con chofer sí); no se investigó.

### R2-02 · El diálogo de cancelar la búsqueda habla de una tarifa que no existe

- **Ronda 2, 2026-11-17.** Botón "Cancelar viaje" mientras busca (`apps/client/app/(tabs)/index.tsx`, `SearchingView`).
- **Qué pasa:** el diálogo dice "¿Cancelar la búsqueda?" y "Perderás el progreso de la búsqueda actual. Si un conductor ya aceptó, podría aplicar una tarifa de cancelación." Cancelar no cobra nada desde 00372–00374: lo que baja es la calificación. Además `ride.cancel_ride_title` y `ride.cancel_ride_msg` no están en `packages/i18n/src/locales/*/rider.json`, así que en inglés y portugués sale en español. El botón dice "Cancelar viaje" bajo un título que dice "la búsqueda".
- **Esperado:** el texto de la regla actual, traducido en es, en y pt.
- **Volver a probar:** pedir un viaje, tocar "Cancelar viaje" y leer el diálogo con `adb_ui.py dump` (el diálogo sí se puede leer).
- **Arreglo (rama `fix/client-qa-round2`):** el diálogo dice "Todavía no hay conductor asignado, así que cancelar ahora no baja tu calificación.", con los botones "Seguir buscando" y "Cancelar búsqueda", en es, en y pt. Probado en el emulador con `dump`.

### R2-03 · "Buscando cond…" cortado en el indicador de pasos

- **Ronda 2, 2026-11-17.** Indicador de pasos debajo de la tarjeta de búsqueda, pantalla de 360 dp.
- **Qué pasa:** el primer paso sale como "Buscando cond…"; los otros ("Aceptado", "En camino", "En viaje") entran.
- **Esperado:** una etiqueta que entre ("Buscando").
- **Volver a probar:** captura de la pantalla de búsqueda.
- **Arreglo (rama `fix/client-qa-round2`):** el primer paso usa `ride.step_searching` ("Buscando", "Searching", "Buscando"). Probado en el emulador: entra entero.

### R2-04 · "Sin penalización (primera cancelación del día)" con el motivo equivocado

- **Ronda 2, 2026-11-17.** Hoja de cancelar con chofer asignado (`apps/client/src/components/CancelRideSheet.tsx`).
- **Qué pasa:** cuando no hay castigo, la hoja siempre dice "Sin penalización (primera cancelación del día)". Con "Me siento inseguro/a" (que nunca castiga) dice lo mismo. Por el código, también sale dentro de los 2 minutos gratis después de que el chofer acepta. El paréntesis es falso en esos casos, y la ventana es de 24 horas, no "del día".
- **Esperado:** el motivo verdadero, o solo "Sin penalización".
- **Volver a probar:** con un viaje aceptado, abrir la hoja, elegir "Me siento inseguro/a" y leer el recuadro verde con `adb_ui.py dump`. Tocar "Volver" sin cancelar.
- **Arreglo (rama `fix/client-qa-round2`):** dice solo "Sin penalización", y con "Me siento inseguro/a" agrega "Cancelar por seguridad nunca baja tu calificación." (`lib/cancelPenaltyNotice.ts`, con pruebas). Probado en el emulador con un viaje aceptado de QA Moto, sin cancelar.

### R2-05 · "Tu conductor canceló el viaje" aunque no lo canceló el conductor

- **Ronda 2, 2026-11-17.** `apps/client/src/hooks/rideStatusEffects.ts`, al cancelarse un viaje sin que lo pida el pasajero.
- **Qué pasa:** el aviso en pantalla distingue bien tres casos (viaje interrumpido, cancelado sin chofer, cancelado por el chofer), pero después la línea 187 manda siempre la misma notificación al teléfono: "Tu conductor canceló el viaje". Si soporte cancela un viaje que nunca tuvo chofer, el aviso dice lo correcto y la notificación culpa a un conductor que no existió. Además `ride.driver_canceled_title` y `ride.driver_canceled_msg` no están en los JSON de idiomas.
- **Esperado:** la notificación con el mismo texto que el aviso de cada caso.
- **Volver a probar:** pedir un viaje sin choferes conectados, cancelarlo desde el panel (`admin_cancel_ride`) y mirar la notificación del emulador (`adb shell dumpsys notification --noredact | grep -A3 tricigo`).
- **Arreglo (rama `fix/client-qa-round2`):** la notificación del teléfono usa el mismo título y texto que el aviso de cada caso, y las claves están en los tres idiomas. Lo cubre `rideStatusEffects.test.ts`. No se probó en el emulador: hace falta que un admin cancele un viaje sin chofer.

### R2-06 · "Viaje compartido · Dejar de compartir" sin haber compartido

- **Ronda 2, 2026-11-17.** Pantalla del viaje con chofer asignado (`apps/client/src/components/RideActiveView.tsx:1438`).
- **Qué pasa:** el servidor crea el enlace de seguimiento en todo viaje aceptado (para los SMS a contactos de confianza), y la app muestra "Viaje compartido · Dejar de compartir" siempre que existe ese enlace. María no tiene contactos de confianza y no compartió nada (`share_access_log` vacío para ese enlace), y la app le dice que el viaje está compartido.
- **Esperado:** el indicador solo cuando la persona compartió el viaje o tiene contactos de confianza que reciben el enlace.
- **Volver a probar:** con un viaje aceptado de María, deslizar hasta "Compartir viaje" y ver si aparece "Viaje compartido".

### R2-07 · En Android, el teclado tapa el chat

- **Ronda 2, 2026-11-17.** Chat del viaje, app del pasajero (`apps/client/app/chat/[rideId].tsx:239`). La del conductor tiene el mismo código (`apps/driver/app/chat/[rideId].tsx:243`).
- **Qué pasa:** al tocar "Escribe un mensaje…", el teclado tapa todo menos la cabecera: no se ven los mensajes, ni lo que se escribe, ni el botón Enviar. Tocando donde estaba Enviar se toca la tecla Intro del teclado y se agregan saltos de línea. Con el teclado cerrado, el mensaje sí se envía.
- **Causa probable:** el chat usa `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` en `KeyboardAvoidingView`. Las otras pantallas con teclado (login, verificar teléfono, completar perfil, ticket de soporte) usan `'height'` en Android. Con edge-to-edge (Expo 55), Android ya no achica la ventana solo.
- **Esperado:** el campo y el botón Enviar arriba del teclado, como en las demás pantallas.
- **Volver a probar:** con un viaje aceptado, tocar "Mensaje", tocar el campo de texto y sacar una captura. Se tienen que ver el campo y el botón Enviar arriba del teclado.
- **Arreglo (rama `fix/client-qa-round2`):** `'height'` no alcanzaba. En el emulador el teclado medía 275 dp (screenY 501), pero `KeyboardAvoidingView` tomaba como alto inicial 800 (antes de los márgenes seguros; el real es 712) y comparaba una posición relativa con una absoluta. Los dos chats usan `KeyboardAwareView`: en Android baja el contenido con un relleno igual al alto del teclado que informa el sistema. Probado en el emulador: mensajes, respuestas rápidas, campo y Enviar quedan arriba del teclado, Enviar funciona con el teclado abierto y todo vuelve a su lugar al cerrarlo. Las demás pantallas con `KeyboardAvoidingView` (login, verificar teléfono, ticket de soporte) no se revisaron.

### R2-08 · Con Wi-Fi pero sin internet, ningún aviso

- **Ronda 2, 2026-11-17.** Viaje en curso. Se cortó el HTTPS del emulador 60 s (`iptables -I OUTPUT -p tcp --dport 443 -j REJECT`) con la red Wi-Fi arriba.
- **Qué pasa:** la pantalla siguió en "En viaje, 0 %, 4.7 km restantes" sin ningún aviso, mientras el chofer ya había llegado al destino. Al volver internet, en menos de 15 s pasó a "Llegaste a tu destino" (eso funciona bien).
- **Causa:** `OfflineBanner` usa `useConnectivity`, que solo mira `NetInfo.isConnected` (si hay red), no si hay internet. En Cuba lo común es justamente tener red sin internet.
- **Esperado:** un aviso cuando las llamadas al servidor fallan aunque haya red (por ejemplo, con `isInternetReachable` o contando pedidos fallidos).
- **Volver a probar:** con un viaje en curso, cortar el HTTPS como arriba, esperar 30 s y sacar una captura. Después borrar la regla (`-D` en lugar de `-I`).

### R2-09 · Dos valores en dólares para el mismo saldo

- **Ronda 2, 2026-11-17.** María, 55.972 TC.
- **Qué pasa:** el inicio muestra "↗ $60.18 USD" y la billetera "≈ $60.51". El inicio divide el saldo por la tasa del día (930); la billetera muestra el ancla en dólares (`anchor_usd_cents` = 6051). Las dos coinciden recién cuando la revaluación diaria ajusta el saldo a la tasa nueva.
- **Esperado:** el mismo número en las dos pantallas.
- **Volver a probar:** el día que cambie la tasa (`exchange_rates`), comparar el inicio con la pestaña TriciCoin antes de la revaluación diaria.

### R2-10 · Recargar: "20" en el monto, pero el botón deshabilitado

- **Ronda 2, 2026-11-17.** TriciCoin → Recargar.
- **Qué pasa:** el campo de monto muestra "20" y "Pagar con tarjeta" está deshabilitado. El 20 es solo un texto de ejemplo; el botón se habilita recién al tocar "$20". Parece que hay un monto y el botón no responde.
- **Esperado:** un monto elegido de entrada (y el chip marcado), o el campo vacío.
- **Volver a probar:** abrir Recargar y leer con `dump` si el botón está `disabled`. No pagar.
- **Arreglo (rama `fix/client-qa-round2`):** la hoja abre con $20 elegido (el menor monto que permite el mínimo), la vista previa del cobro visible y "Pagar con tarjeta" habilitado; el campo dice "Otro monto" cuando está vacío. Probado en el emulador sin pagar.

### R2-11 · El método de pago predeterminado no se usa

- **Ronda 2, 2026-11-17.** Ajustes dice "Método de pago predeterminado: TriciCoin", y los dos viajes de hoy salieron en efectivo ("Pagado en efectivo").
- **Causa:** `customer_profiles.default_payment_method` solo lo usa `apps/client/app/profile/settings.tsx`; el viaje arranca siempre con `paymentMethod: 'cash'` (`apps/client/src/stores/ride.store.ts:115`) y nada lo cambia con la preferencia.
- **Esperado:** el viaje arranca con el método elegido en Ajustes.
- **Volver a probar:** con TriciCoin como predeterminado, pedir un viaje y mirar `rides.payment_method` (y en la pantalla final, cómo se pagó).
- **Arreglo (rama `fix/client-qa-round2`):** al elegir el servicio, el viaje toma `default_payment_method` del perfil; lo que la persona elija en ese viaje vale solo para ese viaje, y el siguiente vuelve al de Ajustes. El "último método usado" que había nunca se aplicaba y se quitó. Probado en el emulador: los precios salieron en TRC y el viaje quedó con `payment_method = tricicoin` (los dos anteriores, en efectivo).

### R2-12 · Con la app en inglés, el inicio sigue en español

- **Ronda 2, 2026-11-17.** Inicio con la app en English (Ajustes → Idioma preferido).
- **Qué pasa:** siguen en español "29 grados, La Habana", "Cambiar tema", "SALDO DISPONIBLE", "¿A dónde vamos hoy?", "Buscar dirección o lugar…", "RECIENTES", "Hace un rato", "TU ÚLTIMO VIAJE" y "¿Volver a …?". Solo "Where to?", "Notifications" y las pestañas salen en inglés. Es un caso aparte de R1-03, que es del Perfil.
- **Esperado:** el inicio entero en el idioma elegido (también en portugués).
- **Volver a probar:** poner la app en English, abrir Inicio y hacer `dump`.
- **Arreglo (rama `fix/client-qa-round2`):** se agregaron las 22 claves del inicio que no estaban en ningún idioma, y el clima se lee traducido ("23 degrees, La Habana"). Una prueba revisa que toda clave del inicio exista en es, en y pt. Probado en el emulador en inglés.

### R2-13 · "Idioma preferido" cambia el idioma con un toque

- **Ronda 2, 2026-11-17.** Ajustes.
- **Qué pasa:** cada toque en "Idioma preferido" pasa al idioma siguiente (Español → English → Português → Español) sin mostrar la lista. Quien toca para ver las opciones queda con la app en otro idioma.
- **Esperado:** una lista para elegir el idioma.
- **Volver a probar:** tocar "Idioma preferido" una vez y ver si aparece una lista.
- **Arreglo (rama `fix/client-qa-round2`):** "Idioma preferido" abre una lista con cada idioma en su propio nombre y el actual marcado. Probado en el emulador: el toque no cambia el idioma; elegir English lo cambia. Ojo: elegir un idioma también escribe `preferred_language` en la cuenta (ver R1-03).

### R2-14 · Lector de pantalla: estrellas sin número y remitente genérico en el chat

- **Ronda 2, 2026-11-17.**
- **Qué pasa:** en "Viaje completado", cada estrella de la calificación se anuncia solo como "★", sin decir cuántas. En el chat, los mensajes del chofer se anuncian como "Chat con conductor dijo: …", no con su nombre.
- **Esperado:** "1 estrella" … "5 estrellas", y el nombre del chofer.
- **Volver a probar:** `dump` en la pantalla final del viaje y en el chat, y leer los `desc=`.
- **Arreglo (rama `fix/client-qa-round2`):** cada estrella se lee "1 estrella" … "5 estrellas" y queda marcada al elegirla; los mensajes del chat nombran al chofer por su primer nombre. Probado en el emulador ("QA dijo: Estoy llegando"; QA Moto se llama "QA Moto").
