# Alarma de integridad del VPS

Te avisa por correo, en minutos, si en el VPS de producción vuelve a aparecer
algo parecido a lo que dejó la intrusión: una llave SSH nueva, un archivo en
`sudoers.d`, un servicio de systemd que nadie instaló, un proceso que se hace
pasar por hilo del kernel, una cuenta de sistema con shell o contraseña.

No impide nada: es un **cable trampa**. Cada 5 minutos saca una foto de lo que
un intruso toca para quedarse, la compara con una **línea base** que tú
aprobaste y, si algo se movió, te manda un correo.

## Por qué existe

El VPS (Ubuntu 24.04, login de root solo con llave) estuvo comprometido unos
**cinco meses** sin que nadie se enterara. Lo que se encontró al limpiarlo:

- una puerta trasera **gsocket** instalada como el servicio de systemd
  `defunct.service`, con el proceso renombrado para parecer un hilo del kernel
  (`[netns]`) y el ejecutable **borrado del disco**;
- llaves SSH del intruso en el `authorized_keys` de **~38 cuentas**, incluidas
  carpetas `.ssh` ocultas de cuentas `nologin`;
- **44 archivos** `NOPASSWD` en `/etc/sudoers.d`;
- cuentas de sistema con `/bin/bash` y contraseña;
- superusuarios de MariaDB;
- **borrado repetido de logs**.

Nada de eso generó un aviso. El borrado de logs es la razón de que la alarma
mande el correo **en el momento**: lo que ya salió del servidor no se puede
borrar.

## Qué vigila

Cada hecho es una línea `<categoría> <detalle>`. No hay PIDs, contadores ni
horas en la foto, así que un servidor que no cambió da **exactamente** la misma
foto, y cualquier diferencia significa que algo cambió de verdad.

| Categoría | Qué registra | Por qué |
|---|---|---|
| `ssh_key` | Huella SHA256 de cada llave en `authorized_keys` y `authorized_keys2` de **todas** las cuentas de `/etc/passwd`, más `/root` | Las llaves del intruso en ~38 cuentas, incluidas cuentas `nologin` (una llave en una cuenta sin shell igual sirve para abrir túneles) |
| `ssh_keyfile` | sha256 de cada uno de esos archivos | Detecta también opciones como `command="…"` o `from="…"`, que no cambian la huella |
| `sudoers` | sha256 de `/etc/sudoers` y de cada archivo de `/etc/sudoers.d` | Los 44 archivos `NOPASSWD` |
| `account` | Cuentas con uid 0, con shell de login, miembros de `sudo`/`root`/`adm`/`wheel`, cuentas con contraseña usable o vacía | Cuentas de sistema con `/bin/bash` y contraseña. **Solo nombres**, nunca el hash |
| `unit` | Units habilitadas (`systemctl list-unit-files --state=enabled`) y todo `/etc/systemd/system`: archivos por sha256, enlaces por destino, drop-ins incluidos | `defunct.service` |
| `unit_unpackaged` | Units en `/usr/lib/systemd/system` y `/lib/systemd/system` que no son de ningún paquete (`dpkg -S`) | Otro lugar donde esconder un servicio |
| `cron` | `/etc/crontab`, `/etc/anacrontab`, `/etc/cron.d`, `cron.hourly…yearly`, `/var/spool/cron/crontabs` | Persistencia clásica |
| `boot` | `rc.local`, `ld.so.preload` (**basta con que exista**), `ld.so.conf(.d)`, `/etc/environment`, `/etc/profile(.d)`, `bash.bashrc`, los `.bashrc`/`.profile`/`.bash_profile`/`.bash_logout` de root, `~root/.ssh/rc`, `/etc/ssh/sshrc`, `sshd_config(.d)`, `/etc/pam.d`, `/etc/update-motd.d`, `/etc/apt/apt.conf.d`, `/etc/hosts`; y lo que sshd aplica de verdad (`sshd -T`): `passwordauthentication`, `permitrootlogin`, `allowusers`, `pubkeyauthentication`, `authorizedkeysfile` | Código que corre como root al arrancar, al entrar por SSH o al usar apt; y el endurecimiento de SSH |
| `listen` | Puertos escuchando: protocolo, dirección:puerto y proceso (sin puertos UDP ≥ 32768, que son efímeros) | Una puerta trasera que escucha |
| `proc` | Procesos que corren desde `/tmp`, `/var/tmp`, `/dev/shm` o una carpeta oculta, o cuyo ejecutable estaba ahí y fue borrado; ejecutables que solo existen en memoria (`memfd`); procesos de usuario que se hacen pasar por hilos del kernel (su línea de comando empieza con `[`) | El gsocket se llamaba `[netns]` y su ejecutable estaba borrado |
| `outbound` | **Nombres** de los procesos con conexiones TCP salientes (sin IPs) | Un gsocket mantiene una conexión saliente permanente con su relay |
| `suid_unpackaged` | Archivos SUID/SGID en `/` (mismo sistema de archivos) que no son de ningún paquete | Una escalada de privilegios guardada para volver |

**Nada secreto sale del servidor:** nombres en vez de hashes de contraseña,
huellas en vez de llaves, sha256 en vez de contenido, nombres de proceso en vez
de IPs. Los valores de la config nunca se imprimen. La suite de tests lo
verifica en cada correo y en cada línea de log.

## Cómo decide cuándo avisar

- **Primera ejecución:** crea la línea base en `/var/lib/tricigo/integrity/baseline`
  y **no** manda correo.
- **Después, cada 5 minutos:** compara la foto con la línea base.
  - `ssh_key`, `sudoers`, `account`, `unit`, `cron`, `boot`… (configuración):
    avisa tanto si algo **aparece** (`+`) como si **desaparece** (`-`).
  - `listen`, `proc` y `outbound` (lo que está corriendo) son **listas de
    permitidos**: avisa lo nuevo; lo que desaparece no, porque los servicios se
    reinician y las conexiones se cierran todo el tiempo.
- **Un correo por cambio nuevo.** Mientras un cambio sigue pendiente no se
  repite. Si encima aparece otro, llega un correo nuevo con todo lo pendiente y
  lo nuevo marcado `<- NUEVO`. Cuando el servidor vuelve a coincidir con la
  línea base se borra esa memoria: si el cambio reaparece, se avisa otra vez.
- **Si Resend falla** (respuesta que no es 2xx) no se registra nada y la
  siguiente ejecución lo reintenta. El servicio termina con código 1, así que
  también se ve en `systemctl --failed`.
- **Si la línea base desaparece** después de instalada, se recrea y se avisa:
  borrarla es la forma de "aprobar" un cambio sin que nadie se entere.
- **Sin config, o sin `RESEND_API_KEY`/`ALERT_EMAIL_TO`,** no corre (código 2):
  una alarma que no puede avisar a nadie es decoración.

El asunto de los avisos es siempre **"TriciGo VPS — cambio sospechoso
detectado"** (sirve para un filtro en el correo). El cuerpo agrupa los cambios
por categoría e incluye el servidor, la hora UTC, la hora del último `apt` (si
coincide con el cambio, casi seguro es una actualización de paquetes) y cómo
aceptarlo.

## Regla de diseño

Igual que el [watchdog de Supabase](../supabase-watchdog/README.md):

- Las alertas van **directo a Resend** por HTTPS. Ni base de datos ni Edge
  Functions en el camino.
- La config se **parsea**, nunca se hace `source`: con
  `ALERT_EMAIL_TO=a@x.com, b@x.com` sin comillas, un `source` pierde la
  variable en silencio y ningún aviso sale. Tampoco puede ejecutar nada como
  root por un error de tipeo.
- El estado es local, en `/var/lib/tricigo/integrity/` (700, solo root).
- La clave de Resend viaja en un archivo temporal de cabeceras, no en la línea
  de comando: los argumentos de un proceso los ve cualquiera con `ps`.

Usa **la misma config** que el watchdog: `/etc/tricigo/supabase-health.env`
(`RESEND_API_KEY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`). Las demás claves de
ese archivo las ignora. No hace falta un archivo nuevo.

## Instalación en el VPS

```bash
# 1. Script. Requiere que ya exista /etc/tricigo/supabase-health.env (el del
#    watchdog) con RESEND_API_KEY y ALERT_EMAIL_TO.
scp ops/vps-integrity/integrity-check.sh root@187.77.214.236:/etc/tricigo/integrity-check.sh
ssh root@187.77.214.236 'chown root:root /etc/tricigo/integrity-check.sh && chmod 700 /etc/tricigo/integrity-check.sh'

# Desde Windows: un checkout viejo con core.autocrlf=true puede copiar el script
# con CRLF, y en Linux falla con "cannot execute: required file not found".
# Quitar los CR y comprobar; debe imprimir 0.
ssh root@187.77.214.236 "sed -i 's/\r\$//' /etc/tricigo/integrity-check.sh && bash -n /etc/tricigo/integrity-check.sh && grep -c \$'\r' /etc/tricigo/integrity-check.sh"

# 2. Probar el aviso ANTES de programarlo. Debe salir 0 y te tiene que llegar
#    el correo de PRUEBA. También dice cuántas líneas vigila y cuánto tardó.
ssh root@187.77.214.236 '/etc/tricigo/integrity-check.sh --selftest'

# 3. Instalar y habilitar el timer, y correr la primera vez: esa primera
#    ejecución crea la línea base (sin correo). Se habilita ANTES de crear la
#    línea base a propósito: así sus propias units ya quedan en ella y la
#    primera ejecución del timer no te avisa de sí misma.
scp ops/vps-integrity/systemd/tricigo-integrity-check.* root@187.77.214.236:/etc/systemd/system/
ssh root@187.77.214.236 'systemctl daemon-reload && systemctl enable --now tricigo-integrity-check.timer && /etc/tricigo/integrity-check.sh'

# 4. Revisar la línea base. Es "confianza en el primer uso": lo que esté ahí
#    queda aprobado, así que si la limpieza se olvidó de algo, este es el
#    momento de verlo. Estas son las líneas que más importan:
ssh root@187.77.214.236 'wc -l /var/lib/tricigo/integrity/baseline; grep -E "^(account|ssh_key |sudoers |proc |suid_unpackaged |unit_unpackaged |listen )" /var/lib/tricigo/integrity/baseline'

# 5. Confirmar que corre
ssh root@187.77.214.236 'systemctl list-timers tricigo-integrity-check.timer --no-pager'
ssh root@187.77.214.236 'journalctl -t tricigo-integrity -n 20 --no-pager'
```

El paso 2 no es opcional: `--selftest` manda un correo real y **sale distinto
de 0 si Resend no lo aceptó**. Una alarma que nunca se vio sonar no es una
alarma.

Cada ejecución deja en el journal cuánto tardó la foto (`snapshot Ns`). Lo más
lento es la búsqueda de binarios SUID, que recorre todo el disco; si pasa de un
par de minutos hay que revisarlo, porque el servicio corta a los 240 s.

## Me llegó un aviso

```bash
/etc/tricigo/integrity-check.sh --show      # la diferencia actual; no cambia nada
```

1. **Si NO reconoces el cambio:** trátalo como una intrusión. **No lo
   aceptes** y sigue [Después de una intrusión real](#después-de-una-intrusión-real).
2. **Si es legítimo** (una actualización de paquetes, un deploy, un cambio
   tuyo), apruébalo:

   ```bash
   /etc/tricigo/integrity-check.sh --accept
   ```

   `--accept` toma el estado actual como nueva línea base, muestra lo que
   aprueba y deja constancia en el journal (`accepted: …`). Para `listen`,
   `proc` y `outbound` además **conserva** lo que ya estaba permitido y lo que
   avisaron los correos desde el último `--accept`, aunque ahora no esté activo:
   una conexión que se abrió y se cerró sigue siendo "algo que este servidor
   hace". Por eso, después de una intrusión real **no** se usa `--accept`.

### Después de una intrusión real

1. **Conserva la evidencia** antes de tocar nada:
   `/etc/tricigo/integrity-check.sh --show > /root/integridad-$(date +%F-%H%M).txt`
   y copia el journal (`journalctl -t tricigo-integrity`) fuera del servidor.
2. Limpia (o mejor, reinstala: con root, el intruso pudo dejar cosas fuera de
   lo que esta alarma ve).
3. Reinicia la alarma desde el estado limpio, **borrando el directorio entero**
   (borrar solo el archivo `baseline` dispara el aviso de "desapareció la línea
   base"):

   ```bash
   rm -rf /var/lib/tricigo/integrity && /etc/tricigo/integrity-check.sh
   ```

## Falsos positivos conocidos

Todos se resuelven igual: revisar con `--show` y aprobar con `--accept`.

- **Actualizaciones de paquetes** (`unattended-upgrades` las instala solas):
  pueden cambiar archivos de `/etc/pam.d`, `/etc/apt/apt.conf.d`,
  `/etc/update-motd.d`, `/etc/profile.d`, units, o reemplazar un binario SUID
  empaquetado (ese no avisa: solo se vigilan los que **no** son de un paquete).
  El correo trae la hora del último `apt`; si coincide, el detalle está en
  `/var/log/apt/history.log`.
- **snap:** cada vez que un snap se actualiza, snapd crea y borra units
  `snap-*.mount` en `/etc/systemd/system`. Si en este servidor no se usa ningún
  snap, desinstalar snapd quita este ruido (y superficie de ataque); decidirlo
  a conciencia, no porque la alarma molesta.
- **Deploys:** reiniciar las apps con pm2 **no** avisa (que un puerto
  desaparezca un momento está permitido). Sí avisan un puerto nuevo, un
  servicio nuevo, o un Node en otra ruta (por ejemplo, si Node vive en
  `/root/.nvm` —carpeta oculta— aparece en `proc` y cambia al actualizarlo).
- **La primera semana**, los procesos que hablan hacia afuera de vez en cuando
  (el `curl` del watchdog, `Runner.Worker`/`git`/`node` durante un deploy, el
  `http` de apt, snapd, certbot) avisan **una vez** cada uno. `--accept` los
  deja permitidos para siempre.
- **Trabajo de administración:** agregar un usuario, editar `sudoers`,
  `crontab -e`, `systemctl enable`/`edit`, conectarse con VS Code Remote (corre
  desde `~/.vscode-server`, carpeta oculta). Es lo esperado: acéptalo después.
- **Reinicios del VPS: no avisan.** Con sshd activado por socket, hasta el
  primer login `sshd -T` falla (no existe `/run/sshd`) y el puerto 22 lo tiene
  solo `systemd`. La alarma reutiliza los últimos valores de `sshd -T` y trata
  el cambio del puerto 22 como una baja, que no avisa.

## Límites (lo que NO hace)

- **No resiste a root.** Quien tenga root puede parar el timer, editar el
  script o fabricar una línea base. La alarma sirve para que el intruso que
  vuelve por el mismo camino no pase inadvertido, no para frenarlo. Borrar
  solo el archivo de línea base sí avisa; **parar el timer o borrar el
  directorio de estado entero no** (es el mismo camino que el reinicio a
  propósito). Un "latido" diario o un chequeo externo de que la alarma sigue
  viva sería el paso siguiente.
- **No mira MariaDB**: no tiene credenciales de la base. Los superusuarios hay
  que revisarlos a mano (`SELECT user, host FROM mysql.user WHERE Super_priv = 'Y';`).
- **No ve** lo que un rootkit de kernel esconda, ni sockets de otros network
  namespaces (contenedores), ni persistencia fuera de las rutas de arriba (por
  ejemplo units de usuario con `loginctl enable-linger`, reglas de udev,
  `/etc/init.d`, código de las apps en `/var/www`).
- **No reemplaza reinstalar** un servidor en el que un intruso tuvo root cinco
  meses.

## Tests

```bash
ops/vps-integrity/tests/run.sh
```

Corren el script **real** contra un sistema de archivos de prueba
(`INTEGRITY_ROOT`), `ss`/`systemctl`/`dpkg`/`sshd` falsos, un `/proc` de
prueba y un mock local de Resend. Incluyen casos **negativos** (Resend que
responde 500, sin canal, sin config): una verificación que nunca se vio fallar
no es una verificación.

Funcionan en Linux y en Git Bash de Windows. En Windows se **omiten** tres
grupos que NTFS no puede representar (bits SUID, nombres de archivo con `\`,
permisos POSIX); en Linux corren todos. `INTEGRITY_TEST_REQUIRE_ALL=1`
convierte cualquier salto en fallo: así se corre en CI
(`.github/workflows/vps-integrity-tests.yml`), para que "verde" signifique que
corrió todo. `INTEGRITY_TEST_KEEP=1` conserva el directorio temporal (fixtures,
estado y cada correo que recibió el mock) para mirar qué pasó.
