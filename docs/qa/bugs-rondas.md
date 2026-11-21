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
| R1-01 | Pasajero | Viaje completado | "★ 5.0 · 1 viajes": falta el singular | verificado (ronda 3) |
| R1-02 | Pasajero | Tarjeta del conductor | La etiqueta de accesibilidad dice "plate" en inglés | verificado (ronda 3) |
| R1-03 | Pasajero | Perfil | Con el teléfono en inglés, mezcla inglés y español | verificado (ronda 3) |
| R1-04 | Pasajero | Elegir servicio | Atrás de Android cierra la app | verificado (ronda 3) |
| R1-05 | Pasajero | Inicio → elegir servicio | Si se toca un destino antes de que la app tenga la ubicación, el origen queda vacío para siempre | verificado (ronda 3) |
| R2-01 | Pasajero | Buscando conductor | En un teléfono de 360×800 dp, "Cancelar viaje" queda debajo del borde y la parte de arriba queda vacía | verificado (ronda 3) |
| R2-02 | Pasajero | Buscando conductor | El diálogo de cancelar avisa de una "tarifa de cancelación" que ya no existe, y no está traducido | verificado (ronda 3) |
| R2-03 | Pasajero | Buscando conductor | El primer paso del indicador sale cortado: "Buscando cond…" | verificado (ronda 3) |
| R2-04 | Pasajero | Hoja de cancelar | "Sin penalización (primera cancelación del día)" también sale cuando el motivo es otro | verificado (ronda 3) |
| R2-05 | Pasajero | Viaje cancelado por otro | La notificación del teléfono dice siempre "Tu conductor canceló el viaje" | verificado (ronda 3) |
| R2-06 | Pasajero | Viaje con chofer | Muestra "Viaje compartido · Dejar de compartir" aunque la persona no compartió nada | abierto |
| R2-07 | Pasajero y conductor | Chat del viaje | En Android, el teclado tapa los mensajes, el campo de texto y el botón Enviar | verificado (ronda 3) |
| R2-08 | Pasajero | Viaje en curso | Con Wi-Fi pero sin internet no aparece ningún aviso de "sin conexión" | abierto |
| R2-09 | Pasajero | Inicio y billetera | El mismo saldo vale $60.18 en el inicio y ≈ $60.51 en la billetera | abierto |
| R2-10 | Pasajero | Recargar | El monto muestra "20" pero "Pagar con tarjeta" sigue deshabilitado | verificado (ronda 3) |
| R2-11 | Pasajero | Ajustes → elegir servicio | El método de pago predeterminado no se usa: los viajes salen en efectivo | verificado (ronda 3) |
| R2-12 | Pasajero | Inicio | Con la app en inglés, el inicio sigue casi todo en español | verificado (ronda 3) |
| R2-13 | Pasajero | Ajustes | Tocar "Idioma preferido" cambia el idioma al instante, sin mostrar opciones | verificado (ronda 3) |
| R2-14 | Pasajero | Calificar y chat | Lector de pantalla: estrellas sin número y remitente del chat genérico | verificado (ronda 3) |
| R3-01 | Pasajero | Inicio → "Tu último viaje" | "Volver a [destino]" termina en "Ubicación inválida" y no deja pedir el viaje | verificado (ronda 4) |
| R3-02 | Pasajero | Elegir servicio | Con la app en inglés, el selector de servicio sigue casi todo en español | verificado (ronda 4) |
| R3-03 | Pasajero | Buscar destino y parada | El campo de búsqueda no toma el foco al abrirse: hay que tocarlo | en arreglo (fix/qa-round4) |
| R3-04 | Pasajero | Buscar destino | Las direcciones de Google llegan en inglés ("Vedado, Havana, Cuba") | verificado (ronda 4) |
| R3-05 | Pasajero | Buscar destino | Elegir una zona de Google ("Vedado") ya no pide confirmar el punto en el mapa | verificado (ronda 4) |
| R3-06 | Pasajero y conductor | Notificaciones | Abrir la app o volver al inicio borra todas sus notificaciones del teléfono | verificado (ronda 4) |
| R3-07 | Pasajero | Notificaciones | Si el permiso se da durante la sesión, las notificaciones del viaje caen en el canal "Miscellaneous" | verificado en parte (ronda 4) |
| R3-08 | Pasajero | Accesibilidad | "Back" en inglés, y "Copiado" en un botón que todavía no copió | verificado (ronda 4) |
| R3-09 | Pasajero | Buscar destino | "23 y 12" sugiere "12 e/ Calle 12" | verificado (ronda 4) |
| R4-01 | Pasajero | Buscar destino | Lugares con "Havana" como municipio ("Reparto Bahia · Havana, La Habana"): el sync semanal pisa el municipio que corrigió 00580 | en arreglo (fix/qa-round4) |
| R4-02 | Pasajero | Confirmar el pin de una zona | Confirmar sin mover el pin deja el barrio ("Cayo Hueso, La Habana") como dirección, aunque la pantalla mostraba la dirección exacta | en arreglo (fix/qa-round4) |
| R4-03 | Pasajero | Pantallas claras | La hora y la batería de la barra de estado salen en blanco sobre el fondo crema (a confirmar fuera del dev client) | en arreglo (fix/qa-round4) |
| R4-04 | Pasajero | Buscar destino y parada | "BUSCAR CERCA" sale en filas de 6 y 2, con las etiquetas pegadas ("HospitalesFarmaciasRestaurantes") | en arreglo (fix/qa-round4) |
| R4-05 | Pasajero | Inicio → "Recientes" | La fila sale apilada: el punto, el nombre, "Hace 5h" y la flecha uno debajo del otro | en arreglo (fix/qa-round4) |
| R4-06 | Pasajero | Centro de Seguridad | "Reportar Problema de Seguridad" lleva a la Ayuda, y la Ayuda dice que se reporta desde el Centro de Seguridad | en arreglo (fix/qa-round4) |
| R4-07 | Pasajero | Elegir servicio | El subtítulo de Mensajería es "Delivery" en español, y repite el nombre en inglés y portugués | en arreglo (fix/qa-round4) |

## Fichas

### R1-01 · "1 viajes" en la tarjeta del conductor

- **Ronda 1, 2026-11-17.** Pantalla "Viaje completado" de la app del pasajero, viaje con QA Moto.
- **Qué pasa:** la tarjeta dice "★ 5.0 · 1 viajes".
- **Esperado:** "1 viaje" en singular, en es, en y pt.
- **Volver a probar:** completar un viaje con un chofer QA que tenga exactamente 1 viaje completado (QA Auto y QA Confort tenían 0 el 2026-11-17) y leer la tarjeta con `python scripts/qa/adb_ui.py find viaje`. Mirar también la tarjeta del conductor durante el viaje.
- **Arreglado en #1215:** `ride.driver_rides_count` y `ride.driver_profile_trips` tienen singular y plural en es, en y pt. Vale para la tarjeta durante el viaje, "Viaje completado", el perfil del conductor y la versión web del viaje activo.
- **Verificado (ronda 3, 2026-11-20):** en "Viaje completado" de un viaje con QA Auto, que quedó con 1 viaje: "★ 5.0 · 1 viaje". Durante el viaje, la tarjeta abierta con "Ver más" muestra "★ 5.0" sin la cantidad (QA Auto tenía 0 viajes).

### R1-02 · "plate" en inglés en la etiqueta de accesibilidad

- **Ronda 1, 2026-11-17.** Tarjeta del conductor, app del pasajero en español.
- **Qué pasa:** la descripción para lectores de pantalla es "QA Moto, ★ 5.0 · 1 viajes, 2022 Suzuki GN125 · Negro, plate QA-0141".
- **Esperado:** "placa" (o la palabra del idioma de la app).
- **Volver a probar:** con un viaje aceptado, `python scripts/qa/adb_ui.py find QA-01` y leer el `desc=`.
- **Arreglado en #1215:** la palabra sale de `ride.plate_label` ("Placa QA-0141" con la app en español).
- **Verificado (ronda 3, 2026-11-20):** "Placa QA-0141" (QA Moto) y "Placa QA-0142" (QA Auto) en "Viaje completado".

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
- **Verificado (ronda 3, 2026-11-20):** con la app en inglés, Perfil sale entero en inglés. El selector de servicio todavía no (R3-02).

### R1-04 · Atrás de Android cierra la app al elegir el servicio

- **Ronda 1, 2026-11-17.** Pantalla de elegir el servicio (después de poner el destino).
- **Qué pasa:** el botón Atrás de Android cierra la app. Al volver a abrirla, el pedido sigue guardado.
- **Esperado:** volver al inicio.
- **Volver a probar:** poner un destino, llegar a la lista de servicios y `python scripts/qa/adb_ui.py key BACK`. La app tiene que seguir en primer plano (`dump` muestra `foreground: app.tricigo.client/...`).
- **Arreglado en #1215:** Atrás hace lo mismo que la ✕: vuelve al inicio y descarta el pedido. Con la búsqueda abierta, cierra solo la búsqueda; en "Elegir en el mapa", cierra el selector y vuelve a la búsqueda.
- **Verificado (ronda 3, 2026-11-20):** Atrás en la pantalla de elegir servicio vuelve al inicio.

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
- **Verificado (ronda 3, 2026-11-20):** con el emulador recién reiniciado y los proveedores de prueba sin posición, se tocó un reciente apenas apareció el inicio. El origen quedó en "Punto de recogida" y el mapa no se puso gris. Al mandar la posición, el origen, el trayecto y los precios aparecieron en menos de 3 s.

### R2-01 · "Cancelar viaje" queda fuera de la pantalla mientras busca

- **Ronda 2, 2026-11-17.** Pantalla "Buscando conductor cercano…", emulador de 360×800 dp (un teléfono chico).
- **Qué pasa:** la parte de arriba de la pantalla queda vacía y el botón "Cancelar viaje · 1:39" queda debajo del borde, apenas asomado. Hay que deslizar para encontrarlo. Lo único visible abajo es "¿No aparece conductor? Pide ayuda", que avisa a soporte.
- **Esperado:** el botón de cancelar a la vista sin deslizar.
- **Volver a probar:** pedir un viaje sin choferes de prueba conectados y sacar una captura (`adb_ui.py screenshot`): `dump` no sirve en esta pantalla porque la animación del radar no deja leerla.
- **Arreglo (#1219):** "Cancelar viaje" quedó fijo abajo, fuera del scroll, y el mapa mide 150 dp en pantallas de menos de 860 dp de alto. Probado en el emulador de 360×800: el botón entero a la vista con "¿No aparece conductor? Pide ayuda" también visible. El espacio vacío de arriba es el mapa, que en el emulador no dibuja nada mientras busca (en el viaje con chofer sí); no se investigó.
- **Verificado (ronda 3, 2026-11-20):** en el emulador de 360×800 dp, "Cancelar viaje" se ve entero mientras busca.

### R2-02 · El diálogo de cancelar la búsqueda habla de una tarifa que no existe

- **Ronda 2, 2026-11-17.** Botón "Cancelar viaje" mientras busca (`apps/client/app/(tabs)/index.tsx`, `SearchingView`).
- **Qué pasa:** el diálogo dice "¿Cancelar la búsqueda?" y "Perderás el progreso de la búsqueda actual. Si un conductor ya aceptó, podría aplicar una tarifa de cancelación." Cancelar no cobra nada desde 00372–00374: lo que baja es la calificación. Además `ride.cancel_ride_title` y `ride.cancel_ride_msg` no están en `packages/i18n/src/locales/*/rider.json`, así que en inglés y portugués sale en español. El botón dice "Cancelar viaje" bajo un título que dice "la búsqueda".
- **Esperado:** el texto de la regla actual, traducido en es, en y pt.
- **Volver a probar:** pedir un viaje, tocar "Cancelar viaje" y leer el diálogo con `adb_ui.py dump` (el diálogo sí se puede leer).
- **Arreglo (#1219):** el diálogo dice "Todavía no hay conductor asignado, así que cancelar ahora no baja tu calificación.", con los botones "Seguir buscando" y "Cancelar búsqueda", en es, en y pt. Probado en el emulador con `dump`.
- **Verificado (ronda 3, 2026-11-20):** con los pasos de la ficha.

### R2-03 · "Buscando cond…" cortado en el indicador de pasos

- **Ronda 2, 2026-11-17.** Indicador de pasos debajo de la tarjeta de búsqueda, pantalla de 360 dp.
- **Qué pasa:** el primer paso sale como "Buscando cond…"; los otros ("Aceptado", "En camino", "En viaje") entran.
- **Esperado:** una etiqueta que entre ("Buscando").
- **Volver a probar:** captura de la pantalla de búsqueda.
- **Arreglo (#1219):** el primer paso usa `ride.step_searching` ("Buscando", "Searching", "Buscando"). Probado en el emulador: entra entero.
- **Verificado (ronda 3, 2026-11-20):** el primer paso dice "Buscando" entero.

### R2-04 · "Sin penalización (primera cancelación del día)" con el motivo equivocado

- **Ronda 2, 2026-11-17.** Hoja de cancelar con chofer asignado (`apps/client/src/components/CancelRideSheet.tsx`).
- **Qué pasa:** cuando no hay castigo, la hoja siempre dice "Sin penalización (primera cancelación del día)". Con "Me siento inseguro/a" (que nunca castiga) dice lo mismo. Por el código, también sale dentro de los 2 minutos gratis después de que el chofer acepta. El paréntesis es falso en esos casos, y la ventana es de 24 horas, no "del día".
- **Esperado:** el motivo verdadero, o solo "Sin penalización".
- **Volver a probar:** con un viaje aceptado, abrir la hoja, elegir "Me siento inseguro/a" y leer el recuadro verde con `adb_ui.py dump`. Tocar "Volver" sin cancelar.
- **Arreglo (#1219):** dice solo "Sin penalización", y con "Me siento inseguro/a" agrega "Cancelar por seguridad nunca baja tu calificación." (`lib/cancelPenaltyNotice.ts`, con pruebas). Probado en el emulador con un viaje aceptado de QA Moto, sin cancelar.
- **Verificado (ronda 3, 2026-11-20):** viaje aceptado de QA Auto, motivo "Me siento inseguro/a": "Sin penalización" y "Cancelar por seguridad nunca baja tu calificación.". Se tocó "Volver" sin cancelar.

### R2-05 · "Tu conductor canceló el viaje" aunque no lo canceló el conductor

- **Ronda 2, 2026-11-17.** `apps/client/src/hooks/rideStatusEffects.ts`, al cancelarse un viaje sin que lo pida el pasajero.
- **Qué pasa:** el aviso en pantalla distingue bien tres casos (viaje interrumpido, cancelado sin chofer, cancelado por el chofer), pero después la línea 187 manda siempre la misma notificación al teléfono: "Tu conductor canceló el viaje". Si soporte cancela un viaje que nunca tuvo chofer, el aviso dice lo correcto y la notificación culpa a un conductor que no existió. Además `ride.driver_canceled_title` y `ride.driver_canceled_msg` no están en los JSON de idiomas.
- **Esperado:** la notificación con el mismo texto que el aviso de cada caso.
- **Volver a probar:** pedir un viaje sin choferes conectados, cancelarlo desde el panel (`admin_cancel_ride`) y mirar la notificación del emulador (`adb shell dumpsys notification --noredact | grep -A3 tricigo`).
- **Arreglo (#1219):** la notificación del teléfono usa el mismo título y texto que el aviso de cada caso, y las claves están en los tres idiomas. Lo cubre `rideStatusEffects.test.ts`. No se probó en el emulador: hace falta que un admin cancele un viaje sin chofer.
- **Verificado (ronda 3, 2026-11-20):** se cancelaron desde el panel viajes de María sin chofer. Con la app abierta sale el aviso "Viaje cancelado · Tu viaje fue cancelado. Puedes pedir otro cuando quieras.". Con la app en segundo plano llega el push del servidor "Viaje cancelado · Tu viaje fue cancelado", y al volver a la app salen el aviso y la notificación del teléfono con el texto de arriba. Para leer la notificación hay que dar el permiso de notificaciones al dev client y mandar la app a segundo plano antes de cancelar: con la app al frente, la notificación se borra en menos de un segundo (R3-06). En la primera prueba el aviso salió tres veces para una sola cancelación; en tres intentos más salió una vez.

### R2-06 · "Viaje compartido · Dejar de compartir" sin haber compartido

- **Ronda 2, 2026-11-17.** Pantalla del viaje con chofer asignado (`apps/client/src/components/RideActiveView.tsx:1438`).
- **Qué pasa:** el servidor crea el enlace de seguimiento en todo viaje aceptado (para los SMS a contactos de confianza), y la app muestra "Viaje compartido · Dejar de compartir" siempre que existe ese enlace. María no tiene contactos de confianza y no compartió nada (`share_access_log` vacío para ese enlace), y la app le dice que el viaje está compartido.
- **Esperado:** el indicador solo cuando la persona compartió el viaje o tiene contactos de confianza que reciben el enlace.
- **Volver a probar:** con un viaje aceptado de María, deslizar hasta "Compartir viaje" y ver si aparece "Viaje compartido".
- **Sigue pasando (ronda 3, 2026-11-20):** viaje aceptado de QA Auto, "Viaje compartido · Dejar de compartir".

### R2-07 · En Android, el teclado tapa el chat

- **Ronda 2, 2026-11-17.** Chat del viaje, app del pasajero (`apps/client/app/chat/[rideId].tsx:239`). La del conductor tiene el mismo código (`apps/driver/app/chat/[rideId].tsx:243`).
- **Qué pasa:** al tocar "Escribe un mensaje…", el teclado tapa todo menos la cabecera: no se ven los mensajes, ni lo que se escribe, ni el botón Enviar. Tocando donde estaba Enviar se toca la tecla Intro del teclado y se agregan saltos de línea. Con el teclado cerrado, el mensaje sí se envía.
- **Causa probable:** el chat usa `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` en `KeyboardAvoidingView`. Las otras pantallas con teclado (login, verificar teléfono, completar perfil, ticket de soporte) usan `'height'` en Android. Con edge-to-edge (Expo 55), Android ya no achica la ventana solo.
- **Esperado:** el campo y el botón Enviar arriba del teclado, como en las demás pantallas.
- **Volver a probar:** con un viaje aceptado, tocar "Mensaje", tocar el campo de texto y sacar una captura. Se tienen que ver el campo y el botón Enviar arriba del teclado.
- **Arreglo (#1219):** `'height'` no alcanzaba. En el emulador el teclado medía 275 dp (screenY 501), pero `KeyboardAvoidingView` tomaba como alto inicial 800 (antes de los márgenes seguros; el real es 712) y comparaba una posición relativa con una absoluta. Los dos chats usan `KeyboardAwareView`: en Android baja el contenido con un relleno igual al alto del teclado que informa el sistema. Probado en el emulador: mensajes, respuestas rápidas, campo y Enviar quedan arriba del teclado, Enviar funciona con el teclado abierto y todo vuelve a su lugar al cerrarlo. Las demás pantallas con `KeyboardAvoidingView` (login, verificar teléfono, ticket de soporte) no se revisaron.
- **Verificado (ronda 3, 2026-11-20):** con el teclado abierto se ven el mensaje del chofer, las respuestas rápidas, el campo y Enviar. Enviar mandó el mensaje con el teclado abierto.

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
- **Arreglo (#1219):** la hoja abre con $20 elegido (el menor monto que permite el mínimo), la vista previa del cobro visible y "Pagar con tarjeta" habilitado; el campo dice "Otro monto" cuando está vacío. Probado en el emulador sin pagar.
- **Verificado (ronda 3, 2026-11-20):** con los pasos de la ficha.

### R2-11 · El método de pago predeterminado no se usa

- **Ronda 2, 2026-11-17.** Ajustes dice "Método de pago predeterminado: TriciCoin", y los dos viajes de hoy salieron en efectivo ("Pagado en efectivo").
- **Causa:** `customer_profiles.default_payment_method` solo lo usa `apps/client/app/profile/settings.tsx`; el viaje arranca siempre con `paymentMethod: 'cash'` (`apps/client/src/stores/ride.store.ts:115`) y nada lo cambia con la preferencia.
- **Esperado:** el viaje arranca con el método elegido en Ajustes.
- **Volver a probar:** con TriciCoin como predeterminado, pedir un viaje y mirar `rides.payment_method` (y en la pantalla final, cómo se pagó).
- **Arreglo (#1219):** al elegir el servicio, el viaje toma `default_payment_method` del perfil; lo que la persona elija en ese viaje vale solo para ese viaje, y el siguiente vuelve al de Ajustes. El "último método usado" que había nunca se aplicaba y se quitó. Probado en el emulador: los precios salieron en TRC y el viaje quedó con `payment_method = tricicoin` (los dos anteriores, en efectivo).
- **Verificado (ronda 3, 2026-11-20):** con TriciCoin como método predeterminado, el viaje se creó con `payment_method = tricicoin`.

### R2-12 · Con la app en inglés, el inicio sigue en español

- **Ronda 2, 2026-11-17.** Inicio con la app en English (Ajustes → Idioma preferido).
- **Qué pasa:** siguen en español "29 grados, La Habana", "Cambiar tema", "SALDO DISPONIBLE", "¿A dónde vamos hoy?", "Buscar dirección o lugar…", "RECIENTES", "Hace un rato", "TU ÚLTIMO VIAJE" y "¿Volver a …?". Solo "Where to?", "Notifications" y las pestañas salen en inglés. Es un caso aparte de R1-03, que es del Perfil.
- **Esperado:** el inicio entero en el idioma elegido (también en portugués).
- **Volver a probar:** poner la app en English, abrir Inicio y hacer `dump`.
- **Arreglo (#1219):** se agregaron las 22 claves del inicio que no estaban en ningún idioma, y el clima se lee traducido ("23 degrees, La Habana"). Una prueba revisa que toda clave del inicio exista en es, en y pt. Probado en el emulador en inglés.
- **Verificado (ronda 3, 2026-11-20):** con la app en inglés, el inicio sale en inglés. El selector de servicio todavía no (R3-02).

### R2-13 · "Idioma preferido" cambia el idioma con un toque

- **Ronda 2, 2026-11-17.** Ajustes.
- **Qué pasa:** cada toque en "Idioma preferido" pasa al idioma siguiente (Español → English → Português → Español) sin mostrar la lista. Quien toca para ver las opciones queda con la app en otro idioma.
- **Esperado:** una lista para elegir el idioma.
- **Volver a probar:** tocar "Idioma preferido" una vez y ver si aparece una lista.
- **Arreglo (#1219):** "Idioma preferido" abre una lista con cada idioma en su propio nombre y el actual marcado. Probado en el emulador: el toque no cambia el idioma; elegir English lo cambia. Ojo: elegir un idioma también escribe `preferred_language` en la cuenta (ver R1-03).
- **Verificado (ronda 3, 2026-11-20):** con los pasos de la ficha.

### R2-14 · Lector de pantalla: estrellas sin número y remitente genérico en el chat

- **Ronda 2, 2026-11-17.**
- **Qué pasa:** en "Viaje completado", cada estrella de la calificación se anuncia solo como "★", sin decir cuántas. En el chat, los mensajes del chofer se anuncian como "Chat con conductor dijo: …", no con su nombre.
- **Esperado:** "1 estrella" … "5 estrellas", y el nombre del chofer.
- **Volver a probar:** `dump` en la pantalla final del viaje y en el chat, y leer los `desc=`.
- **Arreglo (#1219):** cada estrella se lee "1 estrella" … "5 estrellas" y queda marcada al elegirla; los mensajes del chat nombran al chofer por su primer nombre. Probado en el emulador ("QA dijo: Estoy llegando"; QA Moto se llama "QA Moto").
- **Verificado (ronda 3, 2026-11-20):** en "Viaje completado" las estrellas se leen "1 estrella" … "5 estrellas" y la elegida queda marcada. En el chat, "QA dijo: Estoy llegando, voy en un Lada blanco".

### R3-01 · "Volver a [destino]" termina en "Ubicación inválida"

- **Ronda 3, 2026-11-20.** Inicio de la app del pasajero, tarjeta "TU ÚLTIMO VIAJE" (`apps/client/app/(tabs)/index.tsx:2578`).
- **Qué pasa:** al tocar "¿Volver a Hotel Nacional de Cuba…?" se abre la pantalla de elegir servicio sin precios ni trayecto, el botón queda en "Selecciona recogida y destino" deshabilitado y sale el aviso "Ubicación inválida · Selecciona la recogida y destino de nuevo". Desde "RECIENTES", el mismo destino funciona.
- **Causa:** `rideService.getRideHistoryFiltered` (`packages/api/src/services/ride.service.ts:1474`) devuelve las filas de `rides` tal cual, y `pickup_location`/`dropoff_location` llegan como texto WKB, no como `{ latitude, longitude }`. La tarjeta guarda ese texto y lo pasa a `setDropoff`, y la validación de `requestEstimate` (`apps/client/src/hooks/useRide.ts:91`) ve `NaN`. Los demás servicios pasan las filas por `transformRideCoordinates` (`_ride-coordinates.ts`), que usa las columnas `dropoff_lat`/`dropoff_lng`. El respaldo de `useDestinationPredictions.ts:72` lee las mismas filas, aunque solo corre cuando falla la función del servidor.
- **Esperado:** el destino del último viaje con sus coordenadas, y los precios en pantalla.
- **Volver a probar:** con un viaje completado, abrir el inicio, tocar la tarjeta "TU ÚLTIMO VIAJE" y hacer `dump`: tienen que aparecer los precios y "Solicitar viaje …".
- **Arreglo (#1224):** `getRideHistoryFiltered` y `getRideHistory` pasan cada fila por `transformRideCoordinates`, así que el historial devuelve `{ latitude, longitude }`. Arregla también el respaldo de `useDestinationPredictions`. El aviso "Ubicación inválida" de `useRide` ahora está traducido.
- **Verificado (ronda 4, 2026-11-20):** "¿Volver a Hotel Nacional de Cuba…?" abre el trayecto con los precios y "Solicitar viaje Triciclo · 2,153 TRC".

### R3-02 · Con la app en inglés, el selector de servicio sigue en español

- **Ronda 3, 2026-11-20.** Pantalla de elegir servicio con la app en English.
- **Qué pasa:** siguen en español los subtítulos de cada servicio ("Económico", "Rápido", "Cómodo", "Exclusiva"), "~N min de viaje" (`index.tsx:4141`), "Envío", "Pasajeros", "AGREGAR PARADA · 0/3" (`index.tsx:4331`, escrito sin `t()`) y "CUP por km" (`index.tsx:4358`). La tarjeta dice "Triciclo" y el botón "Tricycle".
- **Esperado:** la pantalla entera en el idioma elegido, también en portugués.
- **Volver a probar:** poner la app en English (con la app cerrada, `sqlite3 /data/data/app.tricigo.client/databases/RKStorage "UPDATE catalystLocalStorage SET value='en' WHERE key='tricigo_language';"`), elegir un destino y hacer `dump`. Después volver a `es`.
- **Arreglo (#1224):** la tarjeta usa `service_type.*` (el mismo nombre que el botón; en español, "Envío" pasa a "Mensajería"), y el subtítulo `service_desc.*`. Se agregaron `ride.trip_minutes`, `ride.add_stop_counter` y `ride.cup_per_km`, y 15 claves del selector que solo tenían `defaultValue` en español (compartir viaje, código promocional, pasajeros, "Selecciona recogida y destino", mal tiempo…), en es, en y pt. Los métodos de pago usan `payment.*` ("Cash", "Mixed"). "N asientos libres" ahora tiene singular.
- **Verificado (ronda 4, 2026-11-20):** con la app en English, "Tricycle · Budget", "Motorcycle · Fast", "Passengers", "ADD STOP · 0/3", "Estimated fare", "593 CUP per km", "Bad weather ×1.3", "Cash" y "Mixed", "Promo code" y "Share ride". Queda el subtítulo de Mensajería (R4-07).

### R3-03 · El buscador no toma el foco al abrirse

- **Ronda 3, 2026-11-20.** "¿A dónde vas?" en el inicio y "AGREGAR PARADA" en elegir servicio.
- **Qué pasa:** se abre el buscador, pero el teclado no sale y el campo no tiene el foco (`dumpsys input_method` da `mInputShown=false`). Hay que tocar el campo para escribir. En la web, el campo de origen tiene `autoFocus`.
- **Esperado:** el teclado abierto en el campo de búsqueda.
- **A confirmar:** en un teléfono real, por si en el emulador es un tema de tiempos.
- **Volver a probar:** abrir cada buscador y mirar `adb shell dumpsys input_method | grep mInputShown` sin tocar nada.
- **Arreglo (#1224):** `AddressSearchInput` tiene `autoFocus`, que llama a `focus()` 150 ms después de montarse (con el `autoFocus` de `TextInput`, Android a veces no abre el teclado). Lo usan el buscador del inicio (destino, recogida y parada) y el de agregar parada durante el viaje. La etiqueta del campo para el lector de pantalla ya no está fija en "Buscar dirección": es el texto del campo.
- **Vuelve a pasar (ronda 4, 2026-11-20), solo en el buscador de parada.** El de destino abre el teclado unos 4 s después (el emulador estaba cargado). El de "AGREGAR PARADA", en elegir servicio, queda con el foco pero sin teclado: `mInputShown=false` 30 s después, en dos intentos. logcat muestra `ImeTracker … onRequestShow at ORIGIN_CLIENT_SHOW_SOFT_INPUT` y enseguida `onFailed at PHASE_CLIENT_VIEW_SERVED`: el `focus()` de los 150 ms llega antes de que Android conecte el campo con el teclado. En el de destino, y en "Agregar parada" durante un viaje en curso, el mismo pedido termina en `onShown`. Para verlo: `adb logcat -d | grep ImeTracker` después de abrir cada buscador.
- **Arreglo (fix/qa-round4):** `scheduleAutoFocus` (`apps/client/src/lib/autoFocusInput.ts`) vuelve a intentar a los 600 ms y a los 1,4 s, con `blur()` y `focus()`, mientras el campo tenga el foco y el teclado no haya abierto. Un segundo `focus()` solo no sirve: React Native no enfoca de nuevo el campo que cree enfocado. Si la persona tocó otra cosa, no le saca el foco.

### R3-04 · Las direcciones de Google llegan en inglés

- **Ronda 3, 2026-11-20.** Buscar destino: "Vedado" da "Vedado, Havana, Cuba", y "capitolo" da "National Capitol of Cuba" primero.
- **Causa:** la búsqueda de Google pide `languageCode: 'es'` (`supabase/functions/search-places-google/_shared/google.ts:73`), pero la segunda llamada, la de los detalles del lugar (`google.ts:186`), no lo pide, y la dirección (`formattedAddress`) sale de esa. El nombre "National Capitol of Cuba" viene de la búsqueda: falta ver si Google lo da así también en español.
- **Esperado:** direcciones y nombres en español.
- **Ojo:** `google_places_cache` guarda cada respuesta 30 días por consulta y zona. Después del arreglo, las consultas ya guardadas siguen en inglés hasta que venzan o se borren.
- **Volver a probar:** buscar un barrio con una consulta que no esté en `google_places_cache` y leer la dirección.
- **Arreglo (#1224):** la llamada de detalles del lugar pide `languageCode=es` y `regionCode=CU`. La clave del caché pasó a `v2`, así que las respuestas guardadas en inglés dejan de usarse sin borrar nada. **Desplegado el 2026-11-20 (versión 21).** En el caché de los 30 días anteriores, el 19 % de las direcciones decía "Havana" sin "La Habana", casi todas de lugares sin calle ("4JVC+8MH, Havana, Cuba"). Después del despliegue, esos lugares llegan con "La Habana", y "Cayo Hueso" también. **Queda:** el barrio Vedado sigue llegando como "Vedado, Havana", aun pidiendo español: es el dato de Google. Para cambiarlo haría falta reescribir "Havana" en las direcciones, y eso queda para decidir.
- **Verificado (ronda 4, 2026-11-20):** "reparto kohly", una consulta que no estaba en el caché, devolvió "2809 La Av. 41, La Habana" y "4H5R+V62, La Habana". El "Havana" de filas como "Reparto Bahia · Havana, La Habana" o "Cayo Cruz · Havana, La Habana" no viene de Google sino de `cuba_pois`: es R4-01.

### R3-05 · Elegir "Vedado" ya no pide confirmar el punto

- **Ronda 3, 2026-11-20.** Buscar destino → "Vedado, Vedado, Havana, Cuba".
- **Qué pasa:** el destino queda en "Vedado, Havana, Cuba", el centro del barrio, sin pasar por el mapa con "Es una zona amplia" (#989).
- **Causa:** la función guarda solo el primer tipo que da Google (`matchedCategory: d.types[0]`, `google.ts:268`). Para Vedado, Google daba `political` el 2026-11-09 a las 00:24 y da `geocode` desde las 00:43 (`google_places_cache`). `isZoneLevelResult` (`packages/utils/src/addressSearch.ts:265`) dice que no es zona cuando la categoría no está en `ZONE_LEVEL_CATEGORIES`, y no prueba el nombre del barrio.
- **Esperado:** cualquier barrio, municipio o ciudad pide confirmar el punto.
- **Volver a probar:** buscar "Vedado" y elegir el resultado de Google: tiene que abrir el mapa para confirmar el punto.
- **Arreglo (#1224):** la función guarda el tipo de zona más específico de todos los que da Google (`pickMatchedCategory`), no solo el primero. Para Vedado queda `sublocality` aunque Google ponga `geocode` primero. Mismo despliegue que R3-04. **Desplegado el 2026-11-20 (versión 21):** buscando "cayo hueso", Google devolvió el barrio como `neighborhood`, y al elegirlo la app pidió "Es una zona amplia — ajusta el pin al lugar exacto". Una zona se ordena debajo de los lugares concretos (#989), así que con "vedado" no entra entre los 6 primeros.
- **Verificado (ronda 4, 2026-11-20):** "cayo hueso" muestra el barrio con "Zona amplia — te pediremos ajustar el pin", y al elegirlo aparece "Es una zona amplia — ajusta el pin al lugar exacto". Lo que pasa al confirmar sin mover el pin es R4-02.

### R3-06 · Abrir la app o volver al inicio borra todas sus notificaciones

- **Ronda 3, 2026-11-20.** Las dos apps.
- **Qué pasa:** cada vez que la app vuelve al frente, desaparecen del teléfono todas sus notificaciones (chat, "tu conductor llegó", ofertas en la del conductor). Con la app abierta pasa también al volver al inicio: al cancelarse el viaje, la notificación "Viaje cancelado" se borró en menos de un segundo (`dumpsys notification`: 4 publicadas y 4 borradas por la misma app).
- **Causa:** las dos apps llaman a `Notifications.setBadgeCountAsync(0)` al volver al frente (`apps/client/src/hooks/useNotifications.ts:475` y `:485`, `apps/driver/src/hooks/useNotifications.ts:433` y `:443`). En Android, expo-notifications 55.0.18 hace `NotificationManager.cancelAll()` cuando el número es 0 (`BadgeHelper.kt`). Además, el inicio del pasajero pide el permiso de ubicación cada vez que se monta (`index.tsx:2104`), aunque ya esté dado. Android abre y cierra su pantalla de permisos en medio segundo, y la app lo cuenta como salir y volver.
- **Esperado:** a decidir. Limpiar el número del ícono no debería borrar notificaciones que la persona no vio. El inicio podría mirar el permiso con `getForegroundPermissionsAsync` antes de pedirlo.
- **Volver a probar:** con el permiso de notificaciones dado, mandar la app a segundo plano, recibir una notificación, abrir la app y mirar `numRemovedByApp` en `adb shell dumpsys notification --noredact | grep -A12 "key='app.tricigo.client'"`.
- **Arreglo (#1224):** en Android ya no se llama a `setBadgeCountAsync(0)` (`clearAppBadge`, en las dos apps): ahí el número del ícono sale de las notificaciones mismas. En iOS 16+ se sigue limpiando, porque allá solo borra el número. El inicio mira el permiso de ubicación antes de pedirlo (`ensureForegroundLocationPermission`). Cuándo borrar una oferta vieja del conductor queda para otra decisión.
- **Verificado (ronda 4, 2026-11-20):** push de prueba solo al token del emulador (API de Expo, canal `rides`) con la app en segundo plano. Después de traerla al frente dos veces, la notificación seguía (`numRemovedByApp=0`) y no apareció la pantalla de permisos.

### R3-07 · Las notificaciones del viaje caen en "Miscellaneous"

- **Ronda 3, 2026-11-20.** App del pasajero, permiso de notificaciones dado con la app abierta.
- **Qué pasa:** logcat dice `Channel 'rides' doesn't exists. Fallback to 'expo_notifications_fallback_notification_channel'`. Las notificaciones locales del viaje salen en el canal genérico "Miscellaneous", sin la vibración del canal "rides".
- **Causa:** el canal `rides` se crea solo en `registerForPushNotifications` (`apps/client/src/services/push.service.ts:60`), que `_layout.tsx:147` llama al arrancar y que corta antes si todavía no hay permiso. `registerPushTokenForUser`, que es lo que pide el permiso desde 2026-09-10, no crea el canal. Se crea recién en el próximo arranque en frío.
- **Esperado:** el canal creado apenas hay permiso, o siempre al arrancar (crear un canal no necesita permiso).
- **Volver a probar:** con una instalación nueva, dar el permiso desde la app, provocar una notificación del viaje y buscar `Channel 'rides'` en logcat.
- **Arreglo (#1224):** el canal `rides` se crea en cada arranque, antes del chequeo de permiso y de `Device.isDevice`, y también al registrar el token después de dar el permiso. El nombre que muestra Android en Ajustes pasó de "Ride updates" a "Viajes".
- **Verificado en parte (ronda 4, 2026-11-20):** el canal `rides` existe ("Viajes", importancia 4, con vibración) y la notificación de prueba cayó en él. No se probó en una instalación nueva: borrar los datos de la app cierra la sesión de María, y solo Eduardo puede volver a entrar con ella.

### R3-08 · "Back" en inglés y "Copiado" antes de copiar

- **Ronda 3, 2026-11-20.** Lector de pantalla.
- **Qué pasa:** el botón de volver se lee "Back" en el chat y en el detalle del viaje (`packages/ui/src/ScreenHeader.tsx:32` lo tiene fijo, y `ProfileScreenHeader.tsx:57` lo usa por defecto). En el detalle del viaje, el botón de copiar el ID se lee "Copiado" antes de tocarlo (`apps/client/app/ride/[id].tsx:221` usa `common:copied` como etiqueta).
- **Esperado:** "Volver" traducido, y "Copiar ID del viaje" en el botón.
- **Volver a probar:** `dump` en el chat y en el detalle de un viaje.
- **Arreglo (#1224):** `ScreenHeader` y `ProfileScreenHeader` leen `common:back` ("Volver"). El botón de copiar dice "Copiar ID del viaje" (`common:copy_ride_id`).
- **Verificado (ronda 4, 2026-11-20):** en el detalle del viaje, "Volver" y "Copiar ID del viaje"; la etiqueta no cambia al tocarlo.

### R3-09 · "23 y 12" sugiere "12 e/ Calle 12"

- **Ronda 3, 2026-11-20.** Buscar "23 y 12".
- **Qué pasa:** el primer resultado es la esquina correcta ("Calle 23 y Calle 12, Plaza de la Revolución"). El cuarto es "12 · 12 e/ Calle 12": una calle "entre" ella misma. El primero, además, se lee dos veces con el lector de pantalla, porque el nombre y la dirección son iguales.
- **Esperado:** sin el resultado que se nombra a sí mismo.
- **Volver a probar:** buscar "23 y 12" y hacer `dump`.
- **Arreglo (#1224):** `searchStreetsSupabase` descarta las filas en que una calle se cruza consigo misma (`isSelfIntersectionLabel`: compara los nombres sin "Calle", "Avenida" y otros prefijos, y con el alias entre paréntesis). Los datos de `street_intersections` no se tocaron. El lector de pantalla lee una sola vez un resultado cuyo nombre y dirección son iguales (`searchResultA11yLabel`).
- **Verificado (ronda 4, 2026-11-20):** "23 y 12" ya no trae "12 e/ Calle 12", y la esquina se lee una sola vez.

### R4-01 · Lugares con "Havana" como municipio

- **Ronda 4, 2026-11-20.** Buscar "reparto kohly" o "cayo hueso": "Reparto Bahia · Havana, La Habana" y "Cayo Cruz · Havana, La Habana".
- **Qué pasa:** el municipio de esas filas es "Havana", que no es un municipio. Medido en prod: 792 lugares activos tienen "Havana" o una variante ("Havana, Cuba", "Old Havana", "Centro Havana"…) y 7.106 de 19.702 tienen un municipio distinto del de su polígono (`_poi_admin_area`). Hay 637 municipios distintos; 00580 los había dejado en 212.
- **Causa:** el sync semanal (`bulk_upsert_pois`) hace `municipality = COALESCE(s.municipality, p.municipality)` con el municipio que trae la fuente (Overture dice "Havana"), y reescribe `location` con el mismo punto. El trigger de 00580 (`tg_cuba_pois_admin_area`) sale enseguida si la ubicación no cambió (`IF TG_OP = 'UPDATE' AND NEW.location::text = OLD.location::text THEN RETURN NEW`), así que el municipio de la fuente queda. Las filas afectadas se actualizaron entre el 2026-09-14 y el 2026-11-16, después de 00580.
- **Esperado:** el municipio y la provincia salen siempre del polígono cuando el punto cae en uno, también después del sync.
- **Volver a probar:**
  ```sql
  WITH a AS (SELECT p.municipality, (public._poi_admin_area(p.location)).municipality AS m6
             FROM cuba_pois p WHERE p.is_active AND p.merged_into IS NULL)
  SELECT count(*) FILTER (WHERE m6 IS NOT NULL AND municipality IS DISTINCT FROM m6) AS drift FROM a;
  ```
  Tiene que dar 0 después del arreglo y seguir en 0 después del sync semanal siguiente. En la app, buscar "cayo hueso" y mirar la fila de "Cayo Cruz".
- **Arreglo (fix/qa-round4):** migración `00693`. El trigger solo sale temprano si no cambió ninguno de los tres campos (ubicación, municipio y provincia), así que una escritura del sync vuelve a tomar los valores del polígono. Cambia solo el cuerpo de la función, sin lock sobre `cuba_pois`. Además corrige las 13.530 filas. Ensayo (`supabase/tests/00693`): sin la migración fallan 4 chequeos y con ella aplicada dos veces da PASS. **No está aplicada en prod.**

### R4-02 · Confirmar el pin de una zona deja el barrio como dirección

- **Ronda 4, 2026-11-20.** Buscar "cayo hueso" → elegir el barrio → "Confirmar ubicación" sin mover el pin.
- **Qué pasa:** la pantalla del mapa muestra la dirección exacta del pin ("Casa Rooms Victoria · Zanja e/ Soledad y Castillejo, Centro Habana", con "Dirección exacta"), pero el destino queda como "Cayo Hueso, La Habana". Al conductor le llega el nombre del barrio, que es lo que la confirmación quería evitar (#989).
- **Causa:** `index.tsx:4048` abre el mapa con `keepAddress: true` también para las zonas, y `ConfirmLocationScreen.tsx:295` conserva el texto elegido si el pin se movió menos de 20 m. Para una calle eso está bien (el texto elegido es más rico que la geocodificación inversa); para una zona es al revés.
- **Esperado:** con una zona, al confirmar se usa la dirección exacta del pin.
- **Volver a probar:** los pasos de arriba y leer el destino con `dump` en elegir servicio.
- **Arreglo (fix/qa-round4):** con una zona, el mapa no recibe el texto elegido (`pickerInitialAddress`), así que "Confirmar" usa la dirección exacta del pin. Verificado en el emulador: el destino quedó "Casa Rooms Victoria, Zanja e/ Soledad y Castillejo, Centro Habana, La Habana".

### R4-03 · La barra de estado sale en blanco sobre fondo claro

- **Ronda 4, 2026-11-20.** Inicio, buscadores y "Agregar parada" recién abierta la app, en tema claro.
- **Qué pasa:** la hora, el Wi-Fi y la batería salen en blanco sobre el crema `#FFFBF5` y casi no se ven. `adb shell dumpsys window | grep mLastAppearance` da `LIGHT_NAVIGATION_BARS`, sin `LIGHT_STATUS_BARS`. Después de pasar por la pantalla del viaje, que usa `Screen`, el inicio queda bien (`LIGHT_STATUS_BARS LIGHT_NAVIGATION_BARS`, íconos oscuros).
- **Causa probable:** el inicio no usa `Screen` (que pone `dark-content` en tema claro) ni monta otro `StatusBar`, así que hereda lo que haya antes: la pantalla de arranque oscura (`#0F0F23`) o el lanzador del dev client.
- **A confirmar:** en un teléfono con la app de la tienda, recién abierta. Si allí se ve bien, es del montaje y se descarta.
- **Volver a probar:** abrir la app en frío en tema claro, `dumpsys window | grep mLastAppearance`, y una captura de la parte de arriba del inicio.
- **Arreglo (fix/qa-round4):** el inicio y la selección de servicio montan un `StatusBar` según el tema. Verificado en el emulador: al abrir la app en frío, `LIGHT_STATUS_BARS LIGHT_NAVIGATION_BARS` y la hora se ve.

### R4-04 · "BUSCAR CERCA" en filas de 6 y 2, con las etiquetas pegadas

- **Ronda 4, 2026-11-20.** Buscador de destino y de parada, pantalla de 360 dp.
- **Qué pasa:** las 8 categorías salen 6 en la primera fila y 2 en la segunda, y las etiquetas se tocan: "HospitalesFarmaciasRestaurantesHoteles". Los centros quedan en x = 84, 188, 305, 418, 514 y 617 px: cada botón ocupa solo lo que mide su texto.
- **Causa probable:** el `width: '25%'` está dentro de una función-estilo de `Pressable` (`apps/client/src/components/AddressSearchInput.tsx:1359`), el caso de CLAUDE.md § "Una función-estilo de `Pressable` PUEDE descartar su bloque de layout". Confirmarlo con el A/B de esa sección antes de cambiarlo.
- **Esperado:** dos filas de 4, con aire entre etiquetas.
- **Volver a probar:** abrir "¿A dónde vas?" y `dump`: los centros de la primera fila tienen que quedar en 4 columnas iguales.
- **Arreglo (fix/qa-round4):** el ancho pasó a un estilo plano, y la opacidad al tocar va en un hijo. Verificado en el emulador: 4 + 4, con los centros en x = 114, 278, 442 y 606. Antes, en el mismo emulador, salían 6 + 2.

### R4-05 · La fila de "Recientes" del inicio sale apilada

- **Ronda 4, 2026-11-20.** Inicio, sección "RECIENTES".
- **Qué pasa:** el punto naranja, el nombre, "Hace 5h" y la flecha "›" salen uno debajo del otro, todos alineados a la izquierda, en vez de una fila. En `dump`, el nombre, la hora y la flecha tienen el mismo centro horizontal (x = 360). El lector de pantalla además lee la flecha ("…, Hace 5h, ›").
- **Causa probable:** `flexDirection: 'row'` está dentro de la función-estilo del `Pressable` (`packages/ui/src/RecentPlacesList.tsx:50`), el mismo caso que R4-04 y que el perfil del conductor de 2026-07-31.
- **Esperado:** punto, texto y flecha en una sola fila, y la flecha fuera de la etiqueta de accesibilidad.
- **Volver a probar:** `dump` del inicio: la flecha tiene que quedar a la derecha (x cerca de 680) y a la altura del nombre.
- **Arreglo (fix/qa-round4):** la fila pasó a un estilo plano, y la etiqueta para el lector de pantalla es "nombre, hace cuánto", sin la flecha. Verificado en el emulador: la flecha queda en x = 666, a la altura de la fila.

### R4-06 · "Reportar Problema de Seguridad" lleva a la Ayuda

- **Ronda 4, 2026-11-20.** Perfil → Centro de Seguridad → "Reportar Problema de Seguridad".
- **Qué pasa:** se abre la Ayuda (preguntas frecuentes). La respuesta a "¿Cómo reporto un problema de seguridad?" dice "Desde el Centro de Seguridad puedes reportar cualquier incidente", que es de donde se vino. Fuera de un viaje en curso, no hay forma de crear un reporte de incidente: el único formulario es el de seguridad del viaje activo (`SafetySheet`). Queda "Crear ticket de soporte", al final de la Ayuda.
- **Causa:** `apps/client/app/profile/safety.tsx:235` hace `router.push('/profile/help')`.
- **Esperado:** a decidir. Un formulario para elegir el viaje y contar qué pasó, o un ticket de soporte con el tema de seguridad ya elegido. Como mínimo, que la respuesta de la Ayuda no mande de vuelta al mismo lugar.
- **Volver a probar:** los pasos de arriba.
- **Arreglo (fix/qa-round4):** el Centro de Seguridad abre la Ayuda con `?newTicket=safety`, que abre el formulario de ticket con el asunto "Problema de seguridad" ya escrito (`helpTicketPreset`). La respuesta de la pregunta frecuente ahora dice que durante un viaje se usa Seguridad o SOS y, si el viaje ya terminó, un ticket desde esa pantalla. No hay categoría de seguridad en los tickets: sumarla necesita migración y cambios en el panel.

### R4-07 · El subtítulo de Mensajería es "Delivery"

- **Ronda 4, 2026-11-20.** Elegir servicio.
- **Qué pasa:** en español la tarjeta dice "Mensajería · Delivery". En inglés, "Delivery · Delivery", y en portugués, "Entregas · Entregas".
- **Causa:** `service_desc.mensajeria` en `rider.json` (#1224 copió el texto que había).
- **Esperado:** un subtítulo que diga algo y no repita el nombre ("Envía paquetes", por ejemplo), en los tres idiomas.
- **Volver a probar:** `dump` de elegir servicio en cada idioma.
- **Arreglo (fix/qa-round4):** el subtítulo es "Paquetes", "Packages" y "Pacotes".

## Notas de la ronda 3 (2026-11-20)

No son bugs todavía. Quedan anotadas para decidir.

- **"TC" y "TRC":** el saldo dice "54,649 TC" y las tarifas "5,456 TRC". Es la misma moneda.
- **El número de no leídas** está en la pestaña Inicio ("47"), no en la campana. Las cancelaciones de prueba lo hicieron subir.
- **"Viajes recurrentes"** en Perfil lleva a "Coming soon": el flag `recurring_rides_enabled` no tiene fila y vale `false`.
- **Mis viajes:** los viajes cancelados muestran la tarifa estimada, aunque no se cobraron.
- **Entorno:** después de un `adb reboot`, con `-memory 2048`, la app dio "TriciGo no responde" (casi 1 GB en swap). `adb shell am kill-all` lo destrabó. No es de la app.

## Notas de la ronda 4 (2026-11-20)

No son bugs todavía. Quedan anotadas para decidir.

- **Tasa de respaldo vieja:** si un viaje no tiene `exchange_rate_usd_cup`, Mis viajes y el detalle calculan los dólares con `DEFAULT_EXCHANGE_RATE = 520` (`packages/utils/src/currency.ts:13`), y la tasa real es 945. La misma tarifa de 5,456 TRC salió "≈ $5.77" en un viaje y "≈ $10.49" en otro. En 60 días solo 3 viajes no tienen tasa, y los 3 los sembraron sesiones de QA por SQL. `index.tsx:1568` usa 300 de respaldo.
- **Moneda en el desglose:** el detalle de un viaje pagado con TriciCoin dice "Tarifa del viaje 5,456 CUP" y "Tarifa final 5,456 TRC". Se suma a la nota de "TC" y "TRC" de la ronda 3.
- **Mayúsculas a la inglesa:** "Contactos de Confianza", "Centro de Seguridad", "Compartir Mi Viaje", "Reportar Problema de Seguridad", "Consejos de Seguridad", "Servicios de Emergencia", "Agregar Contacto". En español va solo la primera en mayúscula. "Recibirán automáticamente un link" podría ser "enlace".
- **Botones repetidos:** con la lista vacía, "Lugares guardados" muestra dos "Agregar lugar" y "Contactos de Confianza" dos "Agregar Contacto".
- **Emergencias:** el Centro de Seguridad ofrece solo "Llamar al 106" (policía). En Cuba la ambulancia es el 104 y los bomberos el 105.
- **Lector de pantalla:** en una fila de zona, el aviso "Zona amplia — te pediremos ajustar el pin" no forma parte de la etiqueta de la fila.
- **Un cierre de la app:** al abrirla en inglés, la app se cerró una vez con `SIGSEGV` en `facebook::react::MountingCoordinator::pullTransaction` (hilo `mqt_v_js`). No se repitió al volver a abrirla. Si aparece en Sentry de producción, es de React Native y no de esta pantalla.
- **Entorno:**
  - Otra sesión corría `pnpm list -r --depth Infinity` (2,8 GB) sobre `node_modules`, y el watcher de Metro no terminó de arrancar en 4 minutos dos veces seguidas ("Failed to start watch mode"). Se levantó con `CI=1` en el `.env` de la worktree, que apaga el watcher; para una ronda no hacen falta recargas.
  - Otra sesión usó el mismo emulador para la app del conductor (Metro en 8082) y cambió el GPS a São Paulo: el clima del inicio pasó a "25° · São Paulo". Si dos sesiones prueban a la vez, conviene repartirse el emulador. La app del conductor quedó "no responde" en segundo plano (`Input dispatching timed out`).
  - `type` sin un campo con foco abrió otra vez Ajustes por el atajo del dev client. Esperar `mInputShown=true` antes de escribir.
