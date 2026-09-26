# Procesos, navegador para agentes y CLI

**Propuesto el 2026-09-25. Fases 1 a 4 hechas el mismo día.** Cuatro piezas que comparten
cimientos: el bridge MCP, `crewd` como dueño de los procesos y una identidad por
quien llama. Se escriben juntas porque cada una asume decisiones de las otras.

1. Las **sesiones de terminal** reciben el MCP de Crew igual que los agentes.
2. Un **gestor de procesos** al estilo de Solo, dentro de `crewd`, con tools
   para que agentes y sesiones arranquen, paren y lean logs.
3. Agentes y sesiones **conducen tabs del navegador de Crew** con tools
   nativas sobre `webContents.debugger`, detrás del gateway y con un lease por
   tab.
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

### chrome-devtools-mcp 1.10.1, leído del paquete (descartado, ver decisión 3)

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
- **Solo en la app empaquetada.** En dev (`crew-dev`, worktrees) el daemon
  sigue siendo hijo de Electron, con su data-dir propio.
- **Bundle movido:** en cada arranque la app compara la ruta del plist con la
  del bundle y lo reinstala si no coinciden.
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
terminal dura lo que dura el proceso. Se genera en el spawn y se revoca **por
token** en `PtyEvents::exit` (así el exit tardío de un proceso viejo no revoca
el del nuevo) y al borrar la sesión.

**Quién llama.** `tools.rs` pasa de `&Session` a un
`Caller { Agent(Session) | Terminal(Session) | User { workspace } }`. El bridge
resuelve el token a un `Caller`; `tools/list`, `find_tool` y cada tool filtran
según él.

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

**Viewer lento:** el reader siempre escribe en el log y en el ring. Al viewer
se le manda solo lo que su crédito permite; si se queda atrás, se descarta y se
le emite `resync`, y xterm se repinta desde el ring. La memoria queda acotada.

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
shim corta a los 20 s (`CALL_TIMEOUT` en `mcp.rs`): el timeout pasa a ser por
llamada, 20 s por defecto y `timeout_s + 10` para `wait_for_log`, que se limita
a 60 s.

### 3. Navegador: tools nativas sobre `webContents.debugger`

**Revisado el 2026-09-25:** se descarta chrome-devtools-mcp. Emular el nivel
browser de CDP para Puppeteer, mapear `pageId` (que se reinicia al reconectar),
el mutex global, un proceso Node empaquetado, su telemetría y un catálogo que
cambia rápido cuestan más que escribir las tools que los agentes usan. Se
pierden performance traces, Lighthouse y emulación; si hacen falta, se suman
luego sobre el mismo canal.

```
Electron main   dueño de los guests; ejecuta las tools con webContents.debugger
   ▲ canal crewd → main (peticiones del daemon por el WebSocket del cliente)
crewd           leases por tab, alcance por workspace, republica en el gateway
   ▲ find_tool / call_tool
sesiones y agentes   van y vienen; el tab se queda
```

**Canal.** Hoy Electron es cliente de crewd y nada va en sentido contrario. El
main abre su propia conexión al daemon y se registra como `browser host`;
crewd le manda `browser_call { tab, tool, args }` y espera la respuesta. Sin
host registrado (ventana cerrada), las tools fallan con "abre Crew para usar
el navegador".

**Tools** (gateway, ninguna core, todas con `tab` opcional; por defecto el
último tab que tomó quien llama):

| Tool | Cómo |
| --- | --- |
| `list_tabs`, `open_tab { url }`, `claim_tab`, `release_tab` | propias de Crew |
| `browser_navigate { url \| back \| forward \| reload }` | `loadURL` / historial |
| `browser_snapshot` | `Accessibility.getFullAXTree` → árbol con `uid` por nodo, mapeado a `backendDOMNodeId` y guardado por tab |
| `browser_click`, `browser_hover { uid }` | `DOM.scrollIntoViewIfNeeded` + `DOM.getBoxModel` + `Input.dispatchMouseEvent` |
| `browser_fill { uid, value }`, `browser_type { text }`, `browser_press { key }` | foco + `Input.insertText` / `Input.dispatchKeyEvent` |
| `browser_screenshot { full_page? }` | `Page.captureScreenshot`, bloque `image` |
| `browser_wait_for { text, timeout_s }` | sondeo del texto de la página |
| `browser_console`, `browser_network` | buffer por tab desde que se engancha el debugger |
| `browser_evaluate { expression }` | `Runtime.evaluate` con `awaitPromise` |

Los uids de un snapshot solo valen hasta el siguiente snapshot del mismo tab;
uno viejo falla con "vuelve a tomar el snapshot".

**Tabs fríos.** El renderer solo mantiene vivos 6 guests más los fijados
(`retention.ts`) y solo monta los workspaces visitados.
- El lease **fija** el guest, igual que DevTools o una descarga.
- `open_tab`/`claim_tab` o una tool sobre un tab frío, o de un workspace no
  montado, le piden al renderer que lo monte oculto y esperan a que el guest se
  enganche (timeout 15 s).
- Cada llamada resuelve el guest actual del tab: si renació, cambió su
  `webContentsId` y el debugger se vuelve a enganchar.

**Leases por tab,** en memoria en crewd:
- **Tomarlo:** con `open_tab`, `claim_tab` o la primera tool sobre el tab. Cada
  llamada lo renueva.
- **Soltarlo:** con `release_tab`, a los 120 s sin uso, al borrar la sesión o
  al salir el proceso de una terminal. El de un agente **no** se suelta al
  terminar el turno; lo suelta el TTL.
- **Conflicto:** "tab X en uso por Y, libre en ~N s; usa otro tab o espera".
- **El usuario manda:** si hace click o escribe en un tab con lease, durante
  3 s se rechazan las tools de input (click, hover, fill, type, press). Las de
  lectura siguen. El tab muestra el avatar de quien lo tiene y un botón para
  soltarlo.

**DevTools abiertas:** `debugger.attach` convive con DevTools en Electron; si
falla, la tool responde "cierra DevTools en este tab".

**Qué tabs se pueden manejar:** los browser tabs del workspace de quien llama.

**Imágenes:** `call_tool` reenvía los bloques `image`. La CLI los guarda en un
archivo e imprime la ruta.

**Modo remoto:** fuera de esta versión.

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

### Fase 0: spike

Descartado junto con chrome-devtools-mcp. Lo que quedaba (argv de codex con
`resume`, claude con `--mcp-config` y `--resume`, debugger junto a DevTools) se
comprueba con tests dentro de cada fase.

### Fase 1: MCP en terminales

`Caller`, revocación por token, `pty_spawn { session }`, flags por provider,
tools según quién llama, `instructions` en el `initialize` y timeout por
llamada. Tests: Rust para el env y los flags de cada provider, y
`scripts/drive.mjs` con una terminal que llame a `list_agents`.

### Fase 2: gestor de procesos

Modo supervisado en `PtyHost`, `resync` del viewer, logs con rotación y cursor,
`ProcessHost` con estados y backoff, RPCs, eventos al cliente, sección
"Commands" por workspace en el sidebar, vista con xterm, tools MCP, aprobación
de `create_process` e importador de `solo.yml`. Tests: Rust para drenar sin
viewer, rotación, cursor, backoff y señales al grupo. Un test de estrés con un
proceso que escupe 50 MB sin nadie mirando.

**Construido**, con estas decisiones de más:
- Un cambio que pide aprobación queda como `proposed` junto a la definición
  aceptada, que sigue corriendo; aprobar lo aplica, rechazar lo descarta. Un
  proceso nuevo rechazado se borra.
- `wait_for_log` sin `since` empieza donde empezó la corrida actual, así que
  arrancar y esperar ve todo el boot. Termina con `ended` si el proceso para.
- El log lleva líneas `[crew] …` entre corridas (comando, salida, reintento);
  `grep_logs` y `wait_for_log` no las cuentan.
- La vista es una página sobre el workspace, no un tab: se abre desde la
  sección "Commands" y cerrarla no toca el proceso.
- Un proceso se nombra por id o por nombre, y los nombres son únicos por
  workspace.
- Las tools viven en `crates/crew-core/src/process_tools.rs` y se registran en
  `crewd::serve`. `timeout_s` es obligatorio en `wait_for_log` y se ajusta a
  1–60 s. `created_by` sale como "Nombre (agent id)" o "the user".
- Al cerrar, `crewd` manda SIGTERM a todos los procesos a la vez y espera un
  solo `stop_grace` para todos antes de que `PtyHost::kill_all` mate el resto.

### Fase 3: CLI

Binario `crew`, `daemon.json`, identidad de usuario, comandos, completions,
menú de instalación y `scripts/crew-dev`.

Hecha así: crate `crates/crew-cli` (lib + binario `crew`); `crewd call` llama
al mismo código y `crewd --mcp` sigue sirviendo solo desde el env de una
sesión. El bridge suma `tools/catalog` (todas las tools de quien llama, para
`crew call --help`) y `whoami` (para `crew status`); `daemon.json` suma `pid`.
Los comandos de procesos y `crew tabs` se escribieron contra los nombres y
argumentos de las fases 2 y 4 (`process`, `tail`, `since`, `pattern`,
`timeout_s`) y fallan con el error del daemon hasta que esas tools existan.
`logs -f` lee con el cursor y espera con `wait_for_log` (patrón vacío) en vez
de sondear. La app vuelve a levantar un daemon que llevaba más de 60 s arriba,
para que `crew daemon restart` no la cierre la segunda vez.

### Fase 4: navegador para agentes

Canal crewd → main, tools nativas, snapshot con uids, leases, fijar y revivir
tabs fríos, bloqueo por input del usuario, avatar en el tab e imágenes en
`call_tool`. Tests: snapshot del catálogo, leases en Rust, tools contra un
guest real en e2e.

### Fase 5: `crewd` como LaunchAgent

plist (solo empaquetado), `kickstart`, handshake de versión, reinstalar si el
bundle se movió, "Quit and stop everything" y `crew daemon install/uninstall`.

### Fase 6: extras

Puertos y, si hacen falta, traces de performance sobre el canal del navegador.

## Riesgos

| Riesgo | Mitigación |
| --- | --- |
| El snapshot nativo es peor que el de chrome-devtools-mcp | Filtrar nodos ignorados, nombres y roles como en su formato; iterar con uso real |
| El mutex de tabs no alcanza con muchos agentes | Cada tab tiene su debugger; las llamadas solo se serializan por tab |
| El modo supervisado rompe el backpressure de las terminales | Es un flag de spawn; las terminales conservan `wait_for_credit`, con un test que lo cubra |
| Un agente crea un proceso dañino | `pending-approval` con autonomía `ask`; `created_by` visible en la UI |
| El debugger choca con DevTools | Mensaje claro y el lease sigue |
| El LaunchAgent apunta a un bundle viejo | Comparar ruta en cada arranque y reinstalar |

## Preguntas abiertas (default elegido)

- **¿`crew.yml` en el repo como fuente de las definiciones?** Default: no;
  sqlite más importador de `solo.yml`.
- **¿Una terminal puede recibir respuesta a un `message_agent`?** Default: no,
  sin respuesta de vuelta.
- **¿Qué tabs puede manejar una sesión?** Default: los de su workspace.
- **TTL del lease.** Default: 120 s.
- **¿Cerrar Crew para los procesos?** Default: no, con la opción explícita en
  el menú.

## Estado

| Fase | Estado |
| --- | --- |
| 0 | descartada |
| 1 | hecha |
| 2 | hecha |
| 3 | hecha. `crew daemon install/uninstall` responden "todavía no" y `stop`/`restart` son best-effort (SIGTERM al pid de `daemon.json`; la app relanza su daemon): la fase 5 suma un `Supervisor` LaunchAgent en `crates/crew-cli/src/daemon.rs` |
| 4 | hecha (ver abajo) |
| 5 | pendiente |
| 6 | pendiente |

### Fase 4: lo que entró

- **Canal.** Electron main abre su propia conexión (`electron/browser/host-link.ts`),
  se registra con `browser_host_register` y se reconecta sola si `crewd`
  reinicia. `crewd` le manda `browser-call { callId, tab, tool, args, page }`
  solo a ese cliente y espera `browser_result { callId, ok, result | error }`;
  solo el cliente al que fue la llamada puede contestarla. El host es un
  cliente "callado": de los eventos solo oye `browser-*`.
- **Rust** (`crew-core`): `browser_relay.rs` (`BrowserRelay::call`, bloqueante,
  "Open Crew to use the browser." sin host), `browser_leases.rs` (TTL 120 s,
  renovación, conflicto, soltar todo lo de una sesión, último tab por quien
  llama, evento `browser-leases`) y `browser_tools.rs` (`BrowserTools`: una
  función por tool, catálogo con schemas, alcance por workspace leyendo los
  strips guardados con `browser::open_pages`). RPCs nuevos:
  `browser_leases_list`, `browser_lease_release` y `browser_tool` (corre una
  tool como el usuario). Borrar la sesión y la salida del pty de una terminal
  sueltan sus leases.
- **Tools en main** (`agent-tools.ts`, `ax-snapshot.ts`, `press.ts`,
  `cdp-page.ts`, `tab-guests.ts`): todas las de la tabla, serializadas por
  tab, con timeout por comando CDP para que uno colgado no trabe el tab.
- **Teclado dentro de la página.** Probado en Electron 44: `Input.dispatchKeyEvent`
  e `Input.insertText` no llegan a un guest cuyo `<webview>` no tiene el foco
  de la ventana, y darle el foco le quitaría el teclado al usuario. `type` y
  `press` reproducen las teclas en la página (eventos de teclado más su efecto
  por defecto: comandos de edición, enviar el form, mover el foco, scroll);
  `fill` escribe con `execCommand("insertText")` y, si el campo no lo acepta,
  usa el setter nativo de `value`. Los clicks sí van por `Input.dispatchMouseEvent`.
- **Tabs ocultos.** Un guest con `display:none` no dibuja: el screenshot nunca
  llega y los clicks caen en una página sin tamaño. Un tab con lease que no está
  a la vista queda montado debajo del pane visible y tapado
  (`Browsers.tsx`, "staged"). Si la ventana está minimizada o una página como
  Settings tapa los tabs, el screenshot cae al último frame
  (`capturePage`) o responde por qué no hay.
- **Tabs fríos.** Un tab con lease se fija en `retention.ts`. Si el tab está frío,
  o su workspace no está montado, main le pide al renderer montarlo
  (`browser:mount`) y espera 15 s a que el guest se reporte
  (`browser:page-guest`). `open_tab` agrega el tab al strip en segundo plano y
  hace leer el strip guardado de ese contexto, así queda persistido.
- **UI:** la pastilla del tab muestra la cara del agente; el pane, una barra con
  "Take back".
- **Tests:** Rust de leases, relay, tools y el ida y vuelta por WebSocket
  (`crewd/tests/browser_host.rs`); vitest del snapshot contra un árbol AX
  grabado en Electron 44, del parseo de teclas, de la serialización por tab y
  del bloqueo por input del usuario. `e2e/browser-agent.test.ts` está escrito
  pero no se corrió (el harness usa la base de datos real en macOS).

- **Gateway.** `BrowserTools` es un `ToolFamily` registrado en `crewd::serve`
  con la misma instancia que usa el canal: las 16 tools, ninguna core, para
  agentes, terminales y el usuario. El `Holder` sale del `Caller`, el alcance
  de `Caller::workspace_id()`, y la respuesta va como `ToolOutput::Content`,
  así que un screenshot llega como bloque `image`. La salida del proceso de
  una terminal suelta sus leases junto con su token (`SpawnOptions::on_exit`).
- `browser_tool` (RPC) se queda: corre una tool como el usuario por el
  WebSocket, que es lo que usa `e2e/browser-agent.test.ts`; la CLI va por el
  bridge con el token del usuario.

**Gateway:** `BrowserTools` implementa `ToolFamily` y se registra en `crewd::serve` junto a las tools de procesos; `crew tabs` llama a `list_tabs`.
