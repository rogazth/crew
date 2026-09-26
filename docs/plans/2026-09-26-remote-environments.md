# Entornos remotos — plan por fases

**Estado:** planificado el 2026-09-26. Fase 1 hecha (falta probarla en el VPS). Rama de trabajo: `feat/remote-env`.

Este documento es autosuficiente: una sesión nueva lo puede ejecutar sin el hilo en el que se decidió. Cada fase termina con la app funcionando, tests verdes y una línea de estado en §9.

## 0. Qué se quiere

Controlar desde la app del Mac todo lo que hoy hace Crew, pero con los agentes, terminales y repos corriendo en otras máquinas: un VPS y un PC de casa, **ambos Ubuntu**. Lo local sigue igual.

- Cada máquina remota corre su propio `crewd`. Crew lo instala desde la app.
- **Settings › Remote environments** da de alta, actualiza y quita máquinas.
- El rail de workspaces sigue siendo uno solo y mezcla workspaces locales y remotos. Un workspace remoto lleva un badge de servidor.
- **⌘O** abre un selector de máquina cuando hay al menos un remoto. Si no hay ninguno, sigue abriendo el diálogo nativo como hoy.
- La red es **Tailscale**, sin servidor intermedio de Crew. El código no depende de Tailscale: un remoto es `host:puerto + token`. Tailscale aparece en la UX (lista de dispositivos, estado directo/relay) y en el instalador (Tailscale SSH).
- **Windows no se soporta**, ni como cliente remoto ni como host.

## 1. Diseño elegido — variante A

El prototipo vive en la rama **`prototype/remote-env`** (commit `7eb6196`). Es la referencia visual; **no se mergea**. Para verlo:

```bash
git switch prototype/remote-env && npm install
npm run prototype            # http://127.0.0.1:1431/?variant=A
node scripts/prototype-shots.mjs   # capturas en out/prototype/
```

Archivos de referencia: `src/prototype/remote/*` y los bloques marcados `PROTOTYPE` en `WorkspaceRail.tsx`, `App.tsx`, `SettingsView.tsx`, `SettingsSidebar.tsx`, `settings.ts`, `useWorkspaces.ts`. El código se escribió con reglas de prototipo (sin tests, estado en memoria): se reescribe, no se copia.

Lo que se construye:

| Pieza | Diseño |
| --- | --- |
| Rail | Badge circular en la esquina superior derecha del mark (`CornerBadge`): relleno `bg-text` con `ServerIcon` en `text-inverse`, recortado con un anillo `bg-sidebar`. Reconectando: `bg-warning` + pulse. Offline: `bg-danger` y el mark en `opacity-35 grayscale`. El `StatusDot` de sesiones queda abajo a la derecha. El tooltip dice máquina, host y latencia |
| ⌘O | Palette en dos pasos (`PalettePicker`). Paso 1: "This Mac" + remotos (nombre, `user@host · OS`, latencia, ⌘1‥n), y "Add a remote environment…" que lleva a Settings con el alta abierta. Offline no se puede elegir. Se recuerda la última máquina. Paso 2 (remoto): `FolderBrowser` |
| `FolderBrowser` | Campo `host:~/` con autocompletado de carpetas, estilo shell: ⇥ completa, ↵ abre (un repo) o entra (una carpeta sin repo), ⌘↵ abre la ruta escrita, ⌫ sobre `/` sube. Recientes primero. Estado offline propio |
| Settings | Sección "Machines" en cards (`Cards`): This Mac y cada remoto con `user@host · OS · crewd x.y.z · N workspaces`, latencia y menú ⋯. Pill "Update 0.1.7 → 0.1.8" cuando el daemon está viejo. Aviso de relay debajo de la fila |
| Menú ⋯ | Reconnect, Update crewd, Restart daemon, Open terminal on machine, Daemon logs, Rename, Remove. **Se suma lo de salud de la variante B** (versión de crewd, CLIs encontradas, reiniciar): en A va como detalle expandible de la fila o en el menú |
| Alta | `AddEnvFlow`, en línea dentro de Settings: dispositivos del tailnet (solo Linux y online; el propio Mac, iOS y los ya agregados aparecen deshabilitados con el motivo), nombre (por defecto el host) y usuario SSH. Después, pasos con check: alcanzar el host, entrar por SSH, subir crewd, iniciar el servicio, emparejar, buscar CLIs. Al final, "Open workspace ⌘O" |
| Network | Estado de Tailscale; toggles "Warn about relayed connections" y "Reconnect on wake" |

## 2. Arquitectura

### Quién guarda qué

**El daemon local** guarda lo que es del cliente:
- La lista de remotos (sin tokens).
- El orden del rail y el workspace activo.
- Las preferencias (`state_*`).
- El historial y las páginas del navegador (`browser_*`), porque el navegador vive en el Mac.

**Cada daemon** guarda lo de sus workspaces: workspaces, sesiones, transcripts, routines, worktrees, archivos, PTYs y turnos. Un workspace remoto existe en el SQLite del remoto, no en el del Mac.

**Los tokens** van en el Keychain, con `safeStorage` de Electron en el main. Nunca en SQLite ni en el renderer más allá de lo que el socket necesita.

### Conexiones

Hoy `src/lib/client/transport.ts` es un singleton con una sola conexión: `request`, `on`, `onReconnect`, `openStream` y `writeStream` a nivel de módulo, con `daemonInfo()` desde el host.

Pasa a ser **una conexión por daemon**:

```
Connection   = la lógica actual de transport.ts, instanciable (url, token)
connections  = Map<envId, Connection>      // "local" siempre existe
registry     = workspaceId → envId, sessionId → envId, streamId → Connection
```

- **Los ids son UUID v4** en todos los daemons, así que se usan tal cual, sin prefijo de entorno. El registro se llena con cada `workspace_list` y `session_list` y con cada create.
- **Enrutamiento en `src/lib/api.ts`.** Las llamadas del workspace resuelven la conexión por `workspaceId`, `sessionId` o `path` (worktrees, archivos). Las globales van a `local`: `state_*`, `browser_*`, `messages_search` sobre local, `agent_installed` por entorno.
- **Eventos** (`session-status`, `transcript-apply`, `routines-changed`, `pty-exit`, `pty-error`): el cliente se suscribe en **cada** conexión con los mismos handlers. Como los ids son únicos, los handlers no cambian.
- **Streams de PTY:** `openStream` devuelve un handle atado a su conexión. El ring buffer y `pty_attach { from }` ya resuelven la reconexión.
- **Si un remoto se cae, lo demás sigue.** Sus workspaces quedan offline en el rail y las requests a esa conexión fallan con un error tipado.
- **Keepalive:** ping del WebSocket cada 5 s y timeout de 15 s. Detecta sockets medio muertos después de dormir el Mac o cambiar de wifi, y la misma medición da la latencia que muestra la UI.

### `crewd serve`

Modo nuevo, además del actual (hijo de Electron con handshake por stdout):

```
crewd serve --listen 100.x.y.z:7777 --data-dir ~/.crew/data
```

- **No muere** por EOF en stdin ni cuando se desconecta un cliente. Solo se detiene con SIGTERM.
- **Token persistente** en `~/.crew/data/token` (0600): se genera la primera vez y se reutiliza.
- **Bind a la IP del tailnet.** Si todavía no existe al arrancar, reintenta con backoff. La unidad de systemd lleva `After=tailscaled.service`.
- **Auth igual que hoy** (`{ auth: token }`), más un `protocol` en la respuesta. Si no coincide, el cliente muestra "Update crewd" y no opera.
- **RPC `daemon_info`:** versión, protocolo, OS, hostname, CPU, memoria, agentes corriendo, home, CLIs instaladas (reutiliza `AgentHost::installed`).
- **RPC `dir_list { path }`:** carpetas hijas y si cada una es un repo git. Es lo que usa `FolderBrowser`.
- **HTTP GET en el mismo puerto**, para las previews: si la request no es un upgrade de WebSocket, se sirve `GET /fs?root=…&path=…` con `Authorization: Bearer`. Rango incluido, y sin salir de `root` (las mismas reglas que hoy aplica `electron/browser/files.ts`).
- **Servicio:** `~/.config/systemd/user/crewd.service` con `loginctl enable-linger` para que corra sin sesión abierta. Binario en `~/.crew/bin/crewd`.

### Instalación (desde el main de Electron)

1. **Build.** El release empaqueta `crewd-linux-x64` y `crewd-linux-arm64` en `resources/`, compilados en cruzado desde el Mac con `cargo zigbuild`. `rusqlite` usa `bundled` y `security-framework` ya está limitado a macOS, así que debería compilar. **Validarlo primero** (fase 1).
2. **SSH.** Se usa el `ssh` del sistema, con `BatchMode=yes` y `ControlMaster` para reutilizar la conexión. Con Tailscale SSH activado en el host no hay llaves que copiar; con `sshd` normal, se usan las llaves del usuario.
3. **Pasos:** `uname -m`, subir el binario que corresponde (`scp`, o `cat >` por ssh), escribir la unidad, `systemctl --user enable --now crewd`, `loginctl enable-linger`, leer el token y hacer el handshake para verificar.
4. **Actualizar** es el mismo flujo, saltándose la unidad si no cambió.
5. **Dispositivos del tailnet:** `tailscale status --json` en el Mac (el CLI del app bundle en macOS: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`). De ahí salen el host, la IP, el OS, si está online y, por peer, si la ruta es directa o por relay (`CurAddr` vacío y `Relay` presente ⇒ relay).

El renderer no ejecuta nada de esto. El preload expone `crewHost.remotes` con `list`, `devices`, `install(progress)`, `update`, `remove` y `token(envId)`.

### Lo que hoy asume disco local

Todo esto tiene que ir por el daemon del workspace, o desactivarse en remoto:

| Hoy | Dónde | Remoto |
| --- | --- | --- |
| Previews HTML/PDF/imagen/media | `electron/browser/files.ts` (`serve`, `followFile`), `src/lib/browser/files.ts`, `FileView`, `ImageView`, `NoPreview` | El protocolo del main hace fetch a `GET /fs` del daemon. `followFile` pasa a eventos de watch del daemon (o polling mientras tanto) |
| Imágenes inline | `useImageSrc`, `markdown/preview.ts`, `markdown/blocks.ts` | Por el mismo `GET /fs` |
| Elegir carpeta | `host.open` en `useWorkspaces.create` | `FolderBrowser` + `dir_list` |
| Soltar archivos desde Finder, adjuntar | `useFileDrop`, `attachments.ts`, `host.pathForFile`, `write_temp_file` | Subir bytes al daemon (`write_temp_file` con contenido) y usar la ruta remota |
| Revelar en Finder / abrir afuera | `FILE_CHANNELS.reveal` / `openExternal` | Ocultos en remoto. Opcional: `vscode://vscode-remote/ssh-remote+<host><path>` |
| `homeDir` y links de rutas en la terminal | `host.homeDir`, `terminalPaths.ts`, `Terminals.tsx` | Home desde `daemon_info` del entorno |
| El navegador ve el dev server | `Browsers.tsx`, `useGuest`, sesiones de Electron | Fase 6: SOCKS5 en crewd, `session.setProxy` por workspace remoto, bypass de loopback quitado (`<-loopback>`) |

Antes de la fase 5, hacer un `grep` de `host.ts` (`filesHost`, `browserHost`, `homeDir`, `pathForFile`, `open`) para confirmar que la tabla está completa.

## 3. Fases

Cada fase se hace en su propia sesión, lee este documento y deja su estado en §9.

### Fase 1 — `crewd serve` y build para Linux

- Subcomando `serve`: `--listen`, token persistente, sin muerte por EOF, bind con reintentos.
- `protocol` en la respuesta de auth; RPCs `daemon_info` y `dir_list`, con sus tipos en `crew-protocol` y `npm run protocol`.
- `GET /fs` en el mismo listener.
- `cargo zigbuild --release --target x86_64-unknown-linux-gnu -p crewd` y `aarch64`, en un script (`scripts/crewd-linux.mjs`).
- **Tests en `crates/crewd/tests`:**
  - `serve` sobre `127.0.0.1:0` responde auth y rechaza un token malo.
  - El token sobrevive a un reinicio.
  - Cerrar stdin no lo mata.
  - `/fs` no sale de `root` (symlink incluido).
  - `dir_list` marca los repos.
- **Verificación manual:** el binario de Linux arranca en el VPS con `serve`, y `websocat` con el token recibe `daemon_info`.

### Fase 2 — Cliente con varias conexiones

- `Connection` instanciable, `connections` y `registry`; `api.ts` enrutado; eventos suscritos en todas las conexiones.
- Keepalive con ping y latencia.
- Lista de remotos en el daemon local y tokens en `safeStorage`. Todavía **sin instalador**: se agregan a mano pegando `host:port` y token en una fila provisional de Settings.
- Rail: `workspace_list` de todas las conexiones, unidas por un orden guardado en local (`rail_order`, con ids). Badge de la variante A y estados online, reconectando y offline.
- Un workspace remoto abre agentes, terminales, worktrees y archivos de texto de punta a punta.
- **Desarrollo sin VPS:** un segundo `crewd serve --listen 127.0.0.1:7788 --data-dir /tmp/crew-remote` hace de remoto. Extender el harness de `e2e/` con esa conexión y un test que:
  - abre un workspace remoto;
  - corre una terminal;
  - mata el daemon remoto y comprueba que el rail lo marca offline sin afectar lo local;
  - lo levanta de nuevo y comprueba que la terminal se reanuda desde el byte correcto.

### Fase 3 — Settings › Remote environments

- Sección `remote` en `SETTINGS_SECTIONS`, `ServerIcon` en `SettingsSidebar` y la vista de cards de la variante A con el detalle de salud.
- `crewHost.remotes` en el main: dispositivos del tailnet, instalación por SSH con progreso por pasos, update, restart, remove (detiene el servicio y pregunta si borrar `~/.crew` remoto) y "Daemon logs" (`journalctl --user -u crewd -n 200`).
- "Open terminal on machine": una sesión de terminal en el home del remoto.
- Aviso de relay a partir de `tailscale status`.

### Fase 4 — ⌘O

- `open-workspace` abre la palette cuando `remotes.length > 0`; con cero remotos, el diálogo nativo.
- `FolderBrowser` sobre `dir_list`, con recientes por máquina en el `state` local.
- "Add a remote environment…" lleva a `openSettings("remote")` con el alta abierta.
- El estado vacío (`EmptyState`, `onCreateWorkspace`) usa el mismo camino.

### Fase 5 — Lo que asumía disco local

- La tabla de §2, de arriba abajo. `GET /fs` desde el protocolo del main, con la conexión resuelta por la raíz del workspace.
- Subida de adjuntos y archivos soltados.
- Acciones de Finder ocultas en remoto.

### Fase 6 — Navegador

- SOCKS5 en `crewd` (solo para conexiones autenticadas: el token va en el usuario y la clave del SOCKS) y `session.setProxy` en las particiones de los workspaces remotos, para que `localhost:3000` abra el dev server del remoto.
- Agentes remotos manejando el navegador del Mac: **depende de `feat/browser-mcp`**, que está en otro worktree. Coordinar al empezar; el cliente se registra como dueño del navegador en cada conexión.

### Fase 7 — Pulido

- Reconnect on wake (`powerMonitor` resume → reconexión inmediata en vez de esperar el ping).
- Toasts cuando un remoto cae o vuelve. Offline en el rail, en ⌘O y en Settings, consistente.
- `README` y `ARCHITECTURE.md`: modo remoto, requisitos (Tailscale, Ubuntu, CLIs con sesión iniciada en la máquina).

## 4. Fuera de alcance

- Windows, como cliente remoto o como host.
- Servidor de Crew en medio, cuentas o sincronización.
- Mover un workspace de una máquina a otra.
- Que un agente le escriba a un agente de otra máquina: cada mailbox es de su daemon.
- Instalar las CLIs de los agentes en el remoto. Crew avisa cuáles faltan y nada más.

## 5. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| El build cruzado falla por alguna dependencia en C | Es lo primero de la fase 1. Plan B: compilar en el propio VPS con `cargo build` durante la instalación, que es más lento pero seguro |
| La ruta al PC de casa va por relay (CGNAT) | Aviso en la UI con la solución: abrir UDP 41641, o usar el VPS como peer relay |
| Versiones distintas de app y daemon | `protocol` en el handshake; update en un click |
| Un remoto lento bloquea la UI | Timeouts por request; ninguna llamada remota en el camino crítico del arranque. El rail pinta local primero y los remotos cuando responden |

## 6. Cómo verificar cada fase

```bash
npm run check
cargo test --workspace
npm run e2e          # con el remoto local de la fase 2 en adelante
```

Y a mano contra el VPS real al cerrar las fases 2, 3 y 5.

## 7. Convenciones

- Commits en inglés, una línea, `<type>: <subject>`, sin atribución.
- Nada del directorio `src/prototype/` entra en esta rama.
- Leer `docs/ARCHITECTURE.md` y `docs/plans/2026-09-04-daemon-and-client.md` (§3 y §10) antes de la fase 1.

## 8. Preguntas abiertas

1. ¿Remove borra `~/.crew` en el remoto o lo deja? Propuesta: preguntar en el confirm, con "dejar" por defecto.
2. ¿Puerto fijo (7777) o elegido en la instalación? Propuesta: fijo y configurable a mano.
3. ¿Las routines de un workspace remoto corren en el remoto aunque el Mac esté apagado? Debería ser sí, porque el scheduler ya vive en el daemon; confirmarlo en la fase 2.

## 9. Estado

| Fase | Estado |
| --- | --- |
| Prototipo | Hecho, variante A elegida. Rama `prototype/remote-env` |
| 1 | Hecho salvo la verificación manual en el VPS. Ver notas abajo |
| 2 | — |
| 3 | — |
| 4 | — |
| 5 | — |
| 6 | — |
| 7 | — |

**Siguiente:** la verificación manual de la fase 1 en el VPS (abajo) y después la fase 2. La fase 2 puede arrancar sin esperar al VPS: su remoto de desarrollo es un `crewd serve` local.

### Notas de la fase 1

- `crewd serve --listen <host:port> [--data-dir <dir>]` (por defecto `~/.crew/data`). Imprime en stdout una línea `{"url": "ws://…"}` sin el token; el token vive en `<data-dir>/token` (0600). Se detiene con SIGTERM o SIGINT; ignora SIGHUP y el EOF de stdin. Si la dirección todavía no existe (o está ocupada), reintenta con backoff hasta 10 s.
- `crewd::serve_on(config, Listen { addr, token, wait_for_addr })`; `serve(config)` sigue siendo el modo local de siempre.
- **Handshake:** después de un `auth` válido, el primer mensaje es el evento `hello` con `{ protocol, version }` (`crew_protocol::PROTOCOL`, hoy `1`). Con token malo el socket se cierra sin `hello`. El cliente actual ignora el evento. En la fase 2 el cliente compara el `protocol` de un remoto con el de su daemon local, así que no hace falta exportar la constante a TS.
- **`daemon_info`** devuelve `MachineInfo`: `version`, `protocol`, `os`, `arch`, `hostname`, `home`, `cpus`, `load` (load average de 1 min), `memoryTotal`, `memoryAvailable` (solo Linux), `agentsRunning` (sesiones `working` o `needs-input`) e `installed` (de `claude`, `codex`, `cursor-agent`, `opencode`). El nombre `DaemonInfo` ya lo usaba el handshake por stdout.
- **`dir_list { path }`** acepta `~` y `~/…` y devuelve `{ path, repo, entries: [{ name, path, repo }] }`: solo carpetas (siguiendo symlinks), ordenadas sin distinguir mayúsculas, con las ocultas incluidas (el `FolderBrowser` decide si mostrarlas). `repo` = tiene `.git`, archivo o carpeta.
- **`GET|HEAD /fs?root=<abs>&path=<relativa>`** con `Authorization: Bearer <token>`, en el mismo puerto (`crates/crewd/src/http.rs` hace a mano el upgrade a WebSocket). Mismas reglas que `electron/browser/serve.ts`: segmentos ocultos rechazados, carpeta → `index.html`, `realpath` dentro de `realpath(root)`. Un rango `bytes=` por request (206/416), `Cache-Control: no-store`, `Connection: close`. 401 sin token, 404 para todo lo demás.
- **Build:** `node scripts/crewd-linux.mjs [x64] [arm64]` (requiere `brew install zig cargo-zigbuild`) deja `target/linux/crewd-linux-{x64,arm64}`. Compila sin cambios en las dependencias; los binarios piden glibc ≥ 2.29 (Ubuntu 20.04 o más nuevo). **Todavía no se empaquetan** en `extraResources`: se hace en la fase 3, que es la primera que los usa, para no exigir zig en cada `app:build`.
- **Pendiente, a mano:** subir `crewd-linux-x64` al VPS, `crewd serve --listen <ip-tailnet>:7777`, y con `websocat` mandar `{"auth":"<token>"}` y `{"id":1,"method":"daemon_info","params":{}}`. No hay Docker en el Mac, así que las ramas de Linux de `machine.rs` (`/etc/os-release`, `/proc/meminfo`) compilan pero no se ejecutaron.
- `cargo test --workspace`: `crew-core::pty::tests::a_pty_child_inherits_nothing_but_its_terminal` falla en esta máquina también sobre el commit base `6b603cd` (un fd heredado del entorno); no tiene que ver con esta fase.
- `npm run e2e` en esta máquina: 25 specs pasan y el resto falla por el entorno (rutas `/tmp` frente a `/private/tmp`, timeouts de 30 s en la UI). `smoke` y `worktrees` fallan igual sobre `6b603cd`, así que no vienen de esta fase; los de archivos (`/fs` de Electron), rail y cookies pasan.
