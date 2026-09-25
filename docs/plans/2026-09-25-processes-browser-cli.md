# Procesos, navegador para agentes y CLI

**Propuesto el 2026-09-25. Nada construido.** Cuatro piezas que comparten
cimientos: el bridge MCP, `crewd` como dueño de los procesos y una identidad por
quien llama. Se escriben juntas porque cada una asume decisiones de las otras.

1. Las **sesiones de terminal** reciben el MCP de Crew igual que los agentes.
2. Un **gestor de procesos** al estilo de Solo, dentro de `crewd`, con tools
   para que agentes y sesiones arranquen, paren y lean logs.
3. Agentes y sesiones **conducen tabs del navegador de Crew** con las tools de
   chrome-devtools-mcp: empaquetado, detrás del gateway, un solo proceso y un
   lease por tab.
4. Una **CLI `crew`** en condiciones.

Y una decisión previa que las cruza a todas: `crewd` deja de morir con la
ventana.

## Lo que hay hoy

Verificado en el código el 2026-09-25.

| Pieza | Estado |
| --- | --- |
| Vida del daemon | Electron lanza `crewd --data-dir <userData>` (`electron/main.ts`, `startDaemon`) y lo reintenta una vez. `crewd` sale con EOF en stdin o una señal (`crates/crewd/src/main.rs`, `wait_for_exit`). Cerrar la app mata todo. |
| PTY | `PtyHost` (`crates/crew-core/src/pty.rs`) tiene spawn, write, resize, attach con ring y kill con escalado. El reader **deja de drenar** a los 256 KB sin ack de xterm (`FLOW_HIGH`, `wait_for_credit`): un proceso sin nadie mirándolo se bloquea. |
| MCP en agentes | `turns.rs` genera el token (`agent_env`) y agrega el flag de cada provider: claude `--mcp-config`, codex `-c mcp_servers.crew.*` más su env, opencode `OPENCODE_CONFIG_CONTENT`. Cursor usa `crew call` desde su shell. |
| MCP en terminales | No hay. El argv lo arma el cliente (`src/lib/sessionCommand.ts`) y llega a `pty_spawn { id, cwd, command, cols, rows }`, que no recibe env ni sabe qué sesión lanza. |
| Tools | `tools.rs`: las `core` se listan siempre y el resto va detrás de `find_tool`/`call_tool`. `tools/list` pasa por el daemon (`mcp.rs:113`), así que puede responder según quién llama. |
| CLI | `crewd` entiende `--mcp`, `call` y el modo daemon, con parsing a mano. `crew call` sin argumentos vuelca schemas JSON y solo imprime el `text` de la respuesta. `~/.local/bin/crew` es un script personal fuera del repo con `dev`/`build` y una ruta fija a `$HOME/Developer/...`. |
| Navegador | v1 hecha (`docs/plans/2026-09-23-browser.md`). Dejó fuera, a propósito, que los agentes lo conduzcan. Tabs persistidos en `browser_pages`, partición propia, guests en `electron/browser/guests.ts`. |

### chrome-devtools-mcp 1.10.1, leído del paquete

- Apache-2.0, **sin dependencias en runtime** (build bundleado), Node `^20.19 || ^22.12 || >=23`.
- Se conecta a un navegador existente con `--wsEndpoint` o `--browserUrl`.
- **`pageIdRouting` viene activado por defecto:** cada tool de página acepta
  `pageId` y se enruta sin `select_page` (`ToolHandler.js`). El propio flag dice
  "useful for concurrent agent sessions".
- **El snapshot es por página:** `textSnapshot` vive en `McpPage` y
  `getElementByUid` resuelve contra la página, así que los uids de A no se
  invalidan por un snapshot de B en otro tab.
- **Un mutex global** (`#toolMutex` en `index.js`): una instancia ejecuta una
  tool a la vez.
- `pageId` es un contador interno (`nextPageId`) que **se reinicia al
  reconectar**. No es el `targetId` de CDP.
- **Telemetría activada por defecto.** Se apaga con `--no-usage-statistics` o
  `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS`. Además busca actualizaciones al
  arrancar; se apaga con `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS`.
- ~62 definiciones de tools. `extensions` y `pwa` solo funcionan con conexión
  por pipe.

---

## Decisiones

### 0. `crewd` vive fuera de la ventana

Pasa a ser un **LaunchAgent** (`~/Library/LaunchAgents/…crewd.plist`) que
apunta al binario dentro del bundle. La app lo instala en el primer arranque y
**se conecta** a él en vez de lanzarlo. Si no responde, lo levanta con
`launchctl kickstart`.

- **Descubrimiento:** `<data-dir>/daemon.json` (0600) con `url`, `token` y
  `version`. Lo lee la app y lo lee la CLI.
- **Cerrar Crew no mata los procesos.** El menú suma "Quit Crew and stop
  everything".
- **Actualizaciones:** handshake de versión. Si el daemon no coincide con la
  app, la app le pide salir y lo relanza; los procesos con `auto_start` vuelven
  solos.

El gestor de procesos y la CLI no dependen de esto para funcionar, pero sin
esto valen la mitad: los procesos mueren al cerrar la ventana y la CLI solo
responde con la app abierta. Se decide ahora, se construye en la fase 5, y todo
lo anterior se escribe sin asumir que Electron es el padre.

### 1. El daemon completa el comando de las sesiones de terminal

`pty_spawn` suma un `session` opcional. El cliente sigue armando el argv base
(`sessionCommand.ts` no cambia) y el daemon lo completa:

1. Comprueba que la sesión exista y sea `kind == "terminal"`.
2. Genera el token con `bridge.mint(session)` y pone `CREW_SOCKET`/`CREW_TOKEN`
   en el env.
3. Agrega el flag del provider reutilizando lo de `providers/*.rs`: `--mcp-config`
   (claude), `-c mcp_servers.crew.*` con su env (codex), `OPENCODE_CONFIG_CONTENT`
   (opencode). Cursor queda solo con el env, para `crew call`.

El cliente no arma esto porque en modo remoto la ruta de `crewd` y el socket
son los de la VM.

**Vida del token:** el de un agente se renueva en cada turno; el de una
terminal dura lo que dura el proceso. Se genera en el spawn y se revoca en
`PtyEvents::exit` y al borrar la sesión (esto último ya existe).

**Tools según quién llama.** `tools/list` y `find_tool` reciben el tipo de
quien llama. Una terminal no tiene turnos: `continue_after_turn` no aparece.
`message_agent` sí, pero sin respuesta de vuelta: la carta llega marcada como de
una terminal que no puede recibir contestación.

**La lista de tools no va al system prompt** de las sesiones interactivas. Va
en el `instructions` del `initialize` de `crew --mcp`, que todos los providers
con MCP muestran al modelo. Así no se toca el prompt de una sesión del usuario.

Claude con `--mcp-config` y sin `--strict-mcp-config` **suma** `crew` a los MCPs
del usuario, no los reemplaza. Funciona en un Claude Code recién autenticado,
sin tocar su config.

### 2. Gestor de procesos en `crewd`

**Definiciones en sqlite**, tabla `processes`: `id`, `workspace_id`, `name`,
`command`, `cwd`, `env`, `auto_start`, `auto_restart`, `created_by` (sesión o
nulo si fue el usuario) y `sort_order`. Con un importador de `solo.yml`, que el
repo ya tiene.

**Corren en un PTY en modo supervisado.** El PTY da colores y deja usar los
atajos interactivos (el `r` de vite). La diferencia con una terminal es que el
reader **nunca espera crédito**: todo va a un log en disco, y xterm se engancha
con `attach` sobre el ring cuando alguien abre la vista. Es un flag de spawn en
`PtyHost`; el control de flujo de las terminales normales no cambia.

**Logs:**
- `<data-dir>/logs/<process-id>/` con rotación a 10 MB y dos archivos.
- Se guardan en crudo con ANSI, para repintarlos en xterm, y se limpian al
  leerlos para un agente.
- El cursor es un offset absoluto en bytes que sobrevive a la rotación.

**Estados:** `stopped`, `starting`, `running`, `paused`, `exited(code)`,
`crashed`.
- `auto_restart` con backoff de 1 s a 30 s, que se reinicia tras 60 s arriba.
  Cinco caídas en dos minutos dejan el proceso en `crashed`.
- Stop: SIGTERM al process group y SIGKILL a los 5 s (configurable; el 1 s de
  las terminales es poco para un servidor).
- Pause/resume: SIGSTOP/SIGCONT al grupo.
- Puertos: `lsof` sobre el árbol del proceso mientras corre. Fase 6.

**Tools:**

| Tool | Visibilidad |
| --- | --- |
| `list_processes` (estado, pid, uptime, puertos, último exit code) | core |
| `start_process`, `stop_process`, `restart_process`, `pause_process`, `resume_process` | gateway |
| `create_process`, `update_process`, `delete_process` | gateway |
| `read_logs { process, tail?, since?, max_bytes? }` → `{ text, cursor }` | gateway |
| `grep_logs { process, pattern, context?, max_matches? }` | gateway |
| `wait_for_log { process, pattern, since?, timeout_s }` → match o timeout | gateway |
| `send_input { process, text }` | gateway |

**Alcance:** quien llama solo ve los procesos de su workspace.

**Permisos:** `create_process` y `update_process` son ejecución arbitraria. Si
quien llama tiene autonomía `ask`, el proceso queda en `pending-approval` hasta
que el usuario lo acepte en la UI, y `start_process` falla con un mensaje claro
mientras tanto. Arrancar y parar procesos que ya existen no pide permiso.

**Watch:** MCP es petición/respuesta y las notificaciones push no las soportan
bien todos los providers. Watch es `wait_for_log` más polling con `cursor`. El
shim corta a los 20 s (`CALL_TIMEOUT` en `mcp.rs`): sube a 120 s, y
`wait_for_log` se limita por debajo del timeout de tool más corto de los
providers (spike, pregunta f).

### 3. Navegador: chrome-devtools-mcp empaquetado, detrás del gateway, un proceso

```
Electron      tabs persistentes, id estable de Crew
   ▲ proxy CDP (127.0.0.1, puerto al azar, ruta con secreto)
   │ solo guests manejables; la UI de Crew nunca aparece
chrome-devtools-mcp   1 proceso por daemon, crewd es su único cliente
   ▲ MCP stdio
crewd         leases por tab, mapa tab ↔ pageId, cola de llamadas
   ▲ find_tool / call_tool
sesiones y agentes   van y vienen; el tab se queda
```

**Empaquetado.** `chrome-devtools-mcp` se fija en `package.json` y `app:build`
lo copia a `Resources/`. Lo lanza `crewd` con el binario de Electron y
`ELECTRON_RUN_AS_NODE=1`: no hace falta Node instalado ni un MCP configurado en
el provider. Siempre con `--no-usage-statistics`,
`CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` y
`CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`, con un test que lo compruebe.

**Un proceso, arrancado en la primera llamada.** Se mata tras 10 min sin
llamadas y se relanza si cae. El tab no pertenece al proceso: cerrar sesiones,
o el proceso, no cierra tabs.

**El proxy CDP vive en el main de Electron,** que es dueño de los webContents.
Emula el nivel browser que Puppeteer pide al conectar (`/json/version`,
`Browser.getVersion`, `Target.getTargets`, `setDiscoverTargets`,
`setAutoAttach`, `attachToTarget` con sesiones flatten) sobre
`webContents.debugger` de cada guest. `Target.createTarget` abre un tab en Crew
y `Target.closeTarget` lo cierra.

Descartado: `--remote-debugging-port`. Es menos código, pero abre todos los
webContents, incluida la UI de Crew, a cualquier proceso local desde el
arranque.

**Superficie de tools.** Se republican detrás del gateway con prefijo
`browser_` (`browser_click`, `browser_take_snapshot`…). Ninguna es core, así
que el prompt no crece.
- **Se ocultan** `new_page`, `close_page`, `select_page`, `list_pages`,
  `get_tab_id` y las categorías que exigen pipe (`extensions`, `pwa`).
- **`pageId` sale del schema;** crewd lo inyecta.
- **Tools propias de Crew:** `list_tabs` (url, título, quién tiene el lease y
  hasta cuándo), `open_tab { url }`, `claim_tab { tab }`, `release_tab { tab }`.
- **Las tools de página aceptan un `tab` opcional.** Por defecto usan el último
  tab que tomó quien llama.
- **Las imágenes pasan tal cual:** `call_tool` reenvía los bloques `image` de
  `take_screenshot`. La CLI los guarda en un archivo e imprime la ruta.

**Leases por tab,** en memoria en crewd:
- **Tomarlo:** con `open_tab`, `claim_tab` o la primera tool sobre el tab. Cada
  llamada lo renueva.
- **Soltarlo:** con `release_tab`, a los 120 s sin uso, al borrar la sesión o
  al salir el proceso de una terminal. El de un agente **no** se suelta al
  terminar el turno, para que pueda seguir en el siguiente; lo suelta el TTL.
- **Conflicto:** otra sesión recibe "tab X en uso por Y, libre en ~N s; usa
  otro tab o espera".
- **El usuario manda:** si hace click o escribe en un tab con lease, durante
  unos segundos se rechazan las tools de input del agente (click, fill, press).
  Las de lectura siguen. El tab muestra el avatar de quien lo tiene y un botón
  para soltarlo a la fuerza.

**Mapa tab ↔ `pageId`.** El proxy conoce `targetId ↔ tab`. crewd tiene que
llegar de `pageId` a `targetId` y rehacer el mapa cuando el MCP se reconecta,
porque el contador se reinicia. Cómo obtenerlo de forma fiable es la pregunta c
del spike.

**Concurrencia.** El mutex global serializa todo: un `wait_for` o un trace de
performance de A bloquea a B aunque estén en tabs distintos. Se empieza con un
proceso. Si aparece contención, se pasa a un pool de 2–3 con afinidad por tab,
sin cambiar nada hacia las sesiones.

**Qué tabs se pueden manejar:** los browser tabs del workspace de quien llama.

**Modo remoto:** chrome-devtools-mcp correría en la VM y tendría que tunelear
el WebSocket del proxy por la conexión del cliente. No entra en esta v1, pero
el proxy queda en una frontera que se puede tunelear.

### 4. CLI `crew`

**Binarios.** `crewd` queda como daemon. `crew` es un binario nuevo con clap:
`--help` con ejemplos, autocompletado (`crew completions zsh|bash|fish`) y
`--json` en todos los comandos. `crewd --mcp` y `crewd call` se mantienen una
versión como alias de `crew mcp` y `crew call`.

**Comandos:**

| Grupo | Comandos |
| --- | --- |
| App | `crew open [path]`, `crew status` |
| Procesos | `crew ps`, `crew start/stop/restart/pause/resume <proc>`, `crew logs <proc> [-f] [-n N] [--grep P]`, `crew proc add/rm/edit` |
| Agentes | `crew agents`, `crew send <agente> <texto>` |
| Navegador | `crew tabs` |
| Tools | `crew call <tool> [json]`; `crew call --help` lista el catálogo y `crew call <tool> --help` muestra sus argumentos |
| Agentes-lado | `crew mcp` (servidor stdio) |
| Daemon | `crew daemon status/stop/restart/install/uninstall` |

Los comandos para humanos son envoltorios delgados sobre las mismas tools
(`ps` → `list_processes`), así que la CLI y el MCP no se desalinean.

**Identidad.** Dentro de una sesión o un agente se usa `CREW_TOKEN`. Desde la
terminal del usuario se lee `daemon.json`: quien llama es el usuario, y el
workspace sale del cwd o de `--workspace`.

**Instalación:** menú "Install `crew` command…", con symlink a `~/.local/bin` si
está en el PATH o a `/usr/local/bin` con permiso de admin.

**Script de dev:** `~/.local/bin/crew` pasa al repo como `scripts/crew-dev`, que
calcula la raíz desde su propia ubicación. El nombre `crew` queda para la CLI
distribuida; si no, en tu máquina nunca estarías probando la real.

---

## Fases

### Fase 0: spike (rama desechable, medio día)

Preguntas que tienen que salir con "sí" o con un plan B:

- **a.** chrome-devtools-mcp 1.10.1 arranca con `ELECTRON_RUN_AS_NODE=1` sobre
  el Node de Electron 44.
- **b.** Puppeteer `connect` contra un proxy sintetizado sobre
  `webContents.debugger`: `list_pages`, `take_snapshot`, `click` y
  `take_screenshot` sobre un guest.
- **c.** Una forma fiable de mapear `pageId ↔ targetId`: `structuredContent` de
  `list_pages`, parsear su texto, u otra.
- **d.** `debugger.attach` convive con la ventana de DevTools abierta sobre el
  mismo tab.
- **e.** El orden de argv funciona: codex con `-c mcp_servers…` junto a
  `resume <id>`, y claude con `--mcp-config` junto a `--resume`.
- **f.** El timeout de tool MCP de claude, codex y opencode, para fijar el
  límite de `wait_for_log`.

### Fase 1: MCP en terminales

`pty_spawn { session }`, token por proceso, flags por provider, tools según
quién llama y `instructions` en el `initialize`.
Tests: Rust para el env y los flags de cada provider, y `scripts/drive.mjs` con
una terminal que llame a `list_agents`.

### Fase 2: gestor de procesos

Modo supervisado en `PtyHost`, logs con rotación y cursor, `ProcessHost` con
estados y backoff, RPCs, eventos al cliente, sección "Commands" por workspace
en el sidebar, vista con xterm, tools MCP y aprobación de `create_process`.
Tests: Rust para drenar sin viewer, rotación, cursor, backoff y señales al
grupo. Un test de estrés con un proceso que escupe 50 MB sin nadie mirando.

### Fase 3: CLI

Binario `crew`, `daemon.json`, identidad de usuario, comandos, completions,
menú de instalación y `scripts/crew-dev`.

### Fase 4: navegador para agentes

Proxy CDP en el main, empaquetado y ciclo de vida de chrome-devtools-mcp,
cliente MCP en crewd, republicación en el gateway, leases, bloqueo por input
del usuario, avatar en el tab e imágenes en `call_tool`.
Tests: snapshot del catálogo republicado, que falla si una actualización cambia
nombres; leases en Rust; proxy con Electron simulado; y un test de que la
telemetría va apagada.

### Fase 5: `crewd` como LaunchAgent

plist, `kickstart`, handshake de versión, "Quit and stop everything" y
`crew daemon install/uninstall`.

### Fase 6: extras

Puertos, importador de `solo.yml`, pool de chrome-devtools-mcp si hubo
contención, y túnel CDP para modo remoto.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| chrome-devtools-mcp cambia nombres y semántica de tools rápido | Versión fijada, snapshot test del catálogo, actualizar a propósito |
| Puppeteer pide al proxy algo que no emula | Spike b; los métodos desconocidos se reenvían al target adjunto o fallan con un mensaje claro |
| El mutex global genera contención | Pool con afinidad por tab (fase 6) |
| El modo supervisado rompe el backpressure de las terminales | Es un flag de spawn; las terminales conservan `wait_for_credit`, con un test que lo cubra |
| Un agente crea un proceso dañino | `pending-approval` con autonomía `ask`; `created_by` visible en la UI |
| El debugger choca con DevTools | Spike d; si chocan, el lease se suspende mientras DevTools esté abierta |
| La telemetría de Google se escapa | Flag, env y un test |

## Preguntas abiertas (default elegido)

- **¿`crew.yml` en el repo como fuente de las definiciones?** Default: no;
  sqlite más importador de `solo.yml`.
- **¿Una terminal puede recibir respuesta a un `message_agent`?** Default: no,
  sin respuesta de vuelta.
- **¿Qué tabs puede manejar una sesión?** Default: los de su workspace.
- **TTL del lease.** Default: 120 s.
- **¿Cerrar Crew para los procesos?** Default: no, con la opción explícita en
  el menú.
- **Tamaño del pool de chrome-devtools-mcp.** Default: 1.

## Estado

| Fase | Estado |
| --- | --- |
| 0 | pendiente |
| 1 | pendiente |
| 2 | pendiente |
| 3 | pendiente |
| 4 | pendiente |
| 5 | pendiente |
| 6 | pendiente |
