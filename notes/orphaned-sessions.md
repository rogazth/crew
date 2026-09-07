# Sesiones huérfanas — bug crítico a corregir en el port a Electron

Crew deja procesos `claude` vivos cuando la app muere sin salida ordenada.
El 2026-09-04 había **11 sesiones huérfanas** acumuladas (1–2 días de
antigüedad) más 31 procesos MCP colgando de ellas: ~5 GB de swap.

## Qué pasa

`sessionCommand.ts` arma el argv y `Terminals.tsx` lo manda a `pty_spawn`:

```
claude --settings {"theme":"light"} --session-id <id> --name <name> --model <m>
```

La limpieza existe pero **solo cubre la salida ordenada**:

- `lib.rs` → `RunEvent::Exit` → `PtyHost::kill_all()`
- `pty.rs` → `impl Drop for PtyHost` → `kill_all()`

Ninguna corre si el proceso muere por SIGKILL, crash, o si matas
`npm run app` durante `tauri dev`. El hijo del PTY queda reparentado a
launchd (`ppid=1`), sigue vivo indefinidamente y arrastra su propio
`chrome-devtools-mcp` + `Solo mcp` (4 procesos extra por sesión).

Agravante: 6 de las 11 compartían el mismo `--session-id`. Se relanzó la
misma sesión una y otra vez sin que muriera la anterior.

## Por qué importa en el port

En Electron el riesgo es idéntico — `node-pty` hereda el mismo modelo: el
hijo sobrevive al padre. Un `app.on('before-quit')` es el equivalente exacto
del `RunEvent::Exit` actual y tiene el mismo agujero. Portar la limpieza tal
cual reproduce el bug.

## Qué hace falta

La limpieza en el padre no basta, porque el caso que falla es justamente
aquel en que el padre no ejecuta nada. Hacen falta las dos mitades:

1. **Reaper de arranque** — al iniciar, barrer procesos con
   `TERM_PROGRAM=Crew` y `ppid=1`. Cubre lo ya acumulado y cualquier crash
   pasado. Es la mitad que de verdad ataja el bug.
2. **Que el hijo se muera solo** — process group propio por sesión y
   watchdog que salga al ver `getppid() == 1`. En Linux esto sería
   `PR_SET_PDEATHSIG`; en macOS no existe equivalente, hay que sondear.

Mantener además la limpieza ordenada actual: es el camino feliz y funciona.

## Cómo verificar

```sh
ps -Ao pid,ppid,etime,args | grep '[c]laude --settings' | awk '$2==1'
```

Sin huérfanos no imprime nada. Repetir después de un `kill -9` a la app:
ese es el escenario que hoy falla.
