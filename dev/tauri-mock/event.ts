type Handler = (event: { event: string; payload: unknown }) => void;

const listeners = new Map<string, Set<Handler>>();

window.__crewMockBus = {
  emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) handler({ event, payload });
  },
};

export async function listen<T>(
  event: string,
  handler: (event: { event: string; payload: T }) => void,
): Promise<() => void> {
  const set = listeners.get(event) ?? new Set();
  listeners.set(event, set);
  set.add(handler as Handler);
  return () => void set.delete(handler as Handler);
}
