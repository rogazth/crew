/**
 * Calls `gone` once `pid` no longer exists. For a process something started
 * without a pipe or a supervisor to end it: an e2e app, whose spec may be
 * killed on a timeout before it closes the app.
 */
export function watchOwner(pid: number, gone: () => void, every = 500): void {
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      // EPERM: it exists, and is somebody else's.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      clearInterval(timer);
      gone();
    }
  }, every);
  timer.unref();
}
