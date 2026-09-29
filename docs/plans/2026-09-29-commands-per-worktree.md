# Comandos: inventario por workspace, ejecuciones por worktree

**Propuesto el 2026-09-29. Fases 1 a 5 hechas el mismo día** (ver "Lo que entró"). Revisión del gestor de procesos que entró en
`2571a95` (plan `2026-09-25-processes-browser-cli.md`, decisión 2). El feature
funciona, pero se armó sin revisar la UI, y el modelo no cubre el caso que más
se da: un agente en un worktree levanta `npm run dev`, nadie más lo ve, y
cuando la sesión termina queda huérfano.

## Lo que hay hoy

Verificado en el código el 2026-09-29.

| Pieza | Estado |
| --- | --- |
| Modelo | Tabla `processes`: una fila es una definición (`name`, `command`, `cwd`, `env`, `auto_start`, `auto_restart`, aprobación). El estado vivo es un `Run` en memoria, **uno por proceso** (`runs: HashMap<process_id, Run>` en `process/mod.rs`). |
| Dónde corre | `cwd_of` resuelve siempre contra `workspace.path` (`process/mod.rs:1336`). No existe correr un comando en un worktree. |
| Logs y PTY | `logs/<process-id>/` y `pty_id = process:<id>`: uno por proceso. |
| `auto_start` | `start_auto` (`process/mod.rs:990`) arranca al boot del daemon todo lo marcado (`crewd/src/lib.rs:679`). |
| solo.yml | Parser a mano (`process/solo.rs`), `solo_preview`/`import_solo`, dos RPC en `crewd`, `SoloImportDialog`, un botón en el sidebar y dos `pathExists` por cada workspace abierto. No está en tools ni en el CLI. |
| Sidebar | `CommandsSection` lista todos los comandos debajo de los worktrees, dentro de la lista de sesiones. Se oculta al filtrar. |
| Vista | Abrir un comando es una **página** (`Pages`, `kind: "process"`): tapa el workspace y sus tabs, como Settings. |
| Dialogs | `ProcessDialog` y `SoloImportDialog` se renderizan dentro del sidebar. `SidebarShell.tsx:86` pone `transform` en cada vista, que pasa a ser el containing block de `position: fixed`: el `Overlay` (`kit.tsx:243`) queda encerrado y recortado en el sidebar. |
| Agentes | Las tools están detrás de `find_tool`. Las instrucciones del MCP (`tools.rs:577`) solo nombran las tools; nada le dice a un agente que use `start_process` en vez de su shell. `Caller::worktree()` ya existe y no se usa en procesos. |

## Decisiones

### 1. Inventario y ejecuciones

Un **comando** es una definición del workspace: el inventario. Una
**ejecución** es ese comando corriendo en un worktree. Hay como mucho una por
comando y worktree.

- La tabla `processes` se queda como está: sigue siendo la definición. En el
  código se sigue llamando `process`; "Commands" es el nombre en la UI.
- `runs` pasa a tener como clave `(process_id, worktree)`. `worktree` es la ruta
  del worktree, o `None` para el checkout principal, igual que
  `sessions.worktree`.
- Las ejecuciones siguen en memoria: mueren con el daemon, como hoy. No hace
  falta persistirlas.
- `cwd` del comando se resuelve contra la raíz del worktree de la ejecución. Un
  `cwd` absoluto se rechaza al crear o editar: correría en el mismo lugar desde
  cualquier worktree, que es justo lo que se quiere evitar. Las filas que ya
  existen con uno absoluto se dejan, y la UI las marca.
- PTY: `process:<id>:<run-key>`, donde `run-key` es `main` o un hash corto de la
  ruta del worktree. Logs en `logs/<process-id>/<run-key>/`. Los logs que ya
  existen pasan a `main`.
- `auto_restart`, backoff y crash limit quedan como están, por ejecución.

**`Process` en el protocolo** gana `runs: Vec<ProcessRun>` y pierde los campos
de estado que hoy lleva a nivel raíz (`state`, `pid`, `stream_id`,
`started_at`, `exit_code`, `restarts`, `pty_id`, `log_cursor`, `run_cursor`):

```
ProcessRun { worktree: Option<String>, state, pid, streamId, startedAt,
             exitCode, restarts, ptyId, logCursor, runCursor,
             startedBy: Option<String>, env: BTreeMap }
```

Una ejecución detenida sigue en `runs` mientras tenga logs, para poder ver por
qué salió. `process-changed` sigue mandando el `Process` completo.

### 2. Quién la lanzó y huérfanas

`startedBy` es el id de la sesión que la arrancó, o `None` si fue el usuario.
Una ejecución es **huérfana** si sigue viva y su `startedBy` ya no existe, o es
una terminal cuyo PTY ya salió. No se mata sola: la página la destaca y el
usuario decide.

**Borrar un worktree** para las ejecuciones que tenga y borra sus logs. El
confirm de `onRemoveWorktree` ya lista las sesiones y los cambios sin guardar;
ahora suma "N comandos corriendo".

### 3. Puertos: env por ejecución

`start_process` y `restart_process` aceptan un `env` que se aplica encima del
del comando, solo para esa ejecución. No hace falta un sistema de plantillas:
el comando corre en la shell del usuario, así que `npm run dev -- --port $PORT`
ya expande. El comando declara el valor por defecto (`PORT=3000`) y el agente
pasa `{ "PORT": "3001" }` en su worktree.

Con autonomía `ask`, un agente solo puede pasar **claves que el comando ya
declara**. Una clave nueva (`NODE_OPTIONS`, por ejemplo) es ejecución
arbitraria y se rechaza con un mensaje claro.

La página muestra el env efectivo de cada ejecución que difiere del declarado.

### 4. Sin `auto_start`

Nada arranca solo al boot: un daemon que arranca y levanta diez servidores
puede saturar la máquina, y los worktrees son temporales. Se elimina:

- `start_auto` y su llamada en `crewd`
- el toggle "Start with Crew"
- `auto_start` de las tools, del CLI y de `ProcessSpec`

La columna se deja en sqlite sin leerla. Sacarla no aporta nada y una migración
destructiva sí es un riesgo.

### 5. Fuera: solo.yml y Pause/Resume en la UI

Se borra entero el import de `solo.yml`:
- `process/solo.rs`, `solo_preview`, `import_solo`
- las RPC `process_solo_preview` y `process_import_solo`
- `SoloEntry`, `SoloImport`, `SoloImported`
- `api.soloPreview`, `api.importSoloYml`, `SoloImportDialog`, `useSoloFile`
- los tests de solo.yml. El test de `crewd/tests/processes.rs` que junta
  aprobación por revisión y solo.yml se parte: la aprobación se queda.

El `solo.yml` de la raíz del repo es del usuario y no se toca.

Pause y Resume salen del menú y del header. Las tools `pause_process` y
`resume_process` se quedan: no molestan detrás del gateway.

### 6. Crear y editar desde agentes

Se mantiene lo que hay: con autonomía `ask`, `create_process` deja el comando en
`pending-approval` y `update_process` guarda una propuesta; el usuario la
aprueba contra la `revision` que leyó. Con `full`, se aplica directo. Lo único
que cambia es dónde se aprueba: en la página Commands.

### 7. Que los agentes usen los comandos de Crew

Sin tocar el prompt del usuario: todo va en el `instructions` del `initialize`
del MCP (`tools.rs:577`), que cada provider ya muestra al modelo como
instrucciones del servidor, y en las descripciones de las tools.

**Regla, con alcance acotado.** Solo lo que se queda corriendo; lo que termina
sigue en la shell del agente:

> For anything that keeps running (dev servers, watchers, workers), use
> start_process instead of backgrounding it in your shell: the user sees it and
> can stop it, and it does not die with your session. Builds, tests and other
> commands that finish run in your shell as usual.

**Inventario en una línea**, armado por quien llama y omitido si está vacío.
Marca lo que ya corre en el worktree de la sesión:

> Commands defined in this workspace: web (npm run dev, running here), worker
> (npm run worker).

Para eso `instructions()` necesita leer los procesos del workspace de quien
llama. `ProcessTools` ya tiene el host y se le agrega un método para ese
resumen.

Las descripciones de `start_process` y `create_process` repiten la regla, porque
es lo que el agente lee cuando busca con `find_tool`.

### 8. Tools según worktree

- `start/stop/restart_process`, `read_logs`, `grep_logs`, `wait_for_log` y
  `send_input` aceptan `worktree?`. Si no se pasa, se usa el de quien llama:
  `Caller::worktree()` para una sesión, y para el usuario (CLI) el worktree de
  la ruta que resolvió el workspace. Si no hay ninguno, el checkout principal.
- `list_processes` devuelve cada comando con sus `runs`, y marca `here` en la
  del worktree de quien llama.
- `stop_process` sobre otro worktree se permite: el usuario también puede
  pedirle a un agente que limpie.
- CLI: `crew process start web [--worktree <path>] [--env PORT=3001]`.

### 9. UI

**Sidebar.** `CommandsSection` sale de la lista de sesiones. En su lugar, una
fila fija "Commands" al pie del sidebar de sesiones, con un badge de cuántas
ejecuciones hay vivas en el workspace y otro de "Review" si hay algo esperando
aprobación. Cada fila de worktree muestra un punto verde si tiene algo
corriendo, con un hover que dice qué. La fila no se oculta al filtrar.

**Página Commands** (`Pages`, `kind: "commands"`, reemplaza a `kind: "process"`):

- Header con "New command".
- Una fila por comando: nombre, comando y un menú (Edit, Copy command, Delete).
  Debajo, sus ejecuciones: worktree (con su color de `worktreeHue`), estado,
  quién la lanzó, uptime, env que difiere, y Start/Stop/Restart y "Logs".
  "Run in…" elige el worktree y, opcionalmente, el env.
- Las huérfanas llevan una marca y un "Stop" a la vista.
- Los pendientes de aprobación van arriba, con el `ApprovalCard` que ya existe.
- Estado vacío: qué es un comando, y el botón.

**Logs como tab.** "Logs" abre un tab `kind: "process"` con
`{ processId, worktree }` en el strip de ese worktree, igual que una terminal.
Así se ve al lado del agente. El contenido es `ProcessTerminal` sobre el PTY de
la ejecución, con una barra arriba: estado, Start/Stop/Restart y un link a la
página. `ProcessView` como página desaparece.

**Dialogs.** `Overlay` pasa a renderizarse con `createPortal` a `document.body`.
Con la página, `ProcessDialog` ya no vive en el sidebar, pero el portal evita
que el bug vuelva con cualquier dialog que se abra desde ahí.

## Fases

Cada fase deja todo andando y con tests.

1. **Limpieza.** Portal en `Overlay`, fuera solo.yml, fuera `auto_start`, fuera
   Pause/Resume de la UI. Commits chicos, uno por punto.
2. **Daemon.** Ejecuciones por `(process_id, worktree)`, `cwd` contra el
   worktree, env por ejecución con la regla de `ask`, `startedBy`, logs y PTY
   por ejecución (con la migración de los logs a `main`), parar al borrar un
   worktree. Protocolo con `runs`. Tests en `process/tests.rs` y
   `crewd/tests/processes.rs`.
3. **Tools, instrucciones y CLI.** `worktree?` y `env?`, `list_processes` con
   `runs`, regla e inventario en `instructions`, descripciones, `crew process`.
   Tests en `process_tools.rs` y `crew-cli/tests`.
4. **UI.** Página Commands, fila del sidebar y puntos en worktrees, tab
   `process`, confirm de borrar worktree. Fuera `CommandsSection` y
   `ProcessView`. Tests de `src/lib/processes.test.ts`.
5. **e2e.** `e2e/agent-tools.test.ts`: un agente en un worktree arranca `web`
   con `PORT`, aparece en la página bajo su worktree, el usuario lo para;
   borrar el worktree para lo que queda.

## Lo que entró

Diferencias con lo de arriba, decididas al implementar:

- **Ejecuciones detenidas tras reiniciar el daemon.** `runs` solo lista las que
  corrieron desde que el daemon arrancó. El log de una ejecución anterior sigue
  en disco y el tab de logs lo pinta: la clave (`main` o `wt-<fnv64>`) sale de
  la ruta, así que no hace falta guardarla.
- **El CLI como usuario** corre en el checkout principal salvo `--worktree`; no
  deduce el worktree del directorio actual.
- **Huérfanas:** solo cuenta la sesión borrada. La ventana no escucha borrados
  hechos fuera de ella (no hay evento `session-removed`): los ve al refrescar.
- **Start desde la página** conserva el env que tenía la ejecución; "Run in…"
  pide uno nuevo.
- `pty::tests::a_pty_child_inherits_nothing_but_its_terminal` ya fallaba en
  `master` corriendo dentro de una terminal de Crew; no es de este cambio.

## Abierto

- Cuándo cuenta una sesión de agente como "terminada" para marcar huérfana: con
  lo de arriba, solo si se borró. Un agente idle entre turnos no deja huérfano
  lo que lanzó. Si en la práctica hace falta más, se agrega "sin turnos hace X".
- Detectar procesos que un agente lanzó por su shell (puertos escuchando bajo el
  árbol de su PTY) queda fuera. Se retoma si la regla del punto 7 no alcanza.
