import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// Tells React the updates below run inside act(), so it flushes them there and
// does not warn. Needs a DOM: files that use this run under happy-dom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export { act };

export type HookHandle<P, R> = {
  /** What the hook returned on its latest render. */
  result: { readonly current: R };
  /** How many times the hook has rendered. */
  renders(): number;
  rerender(props: P): void;
  unmount(): void;
};

type Wrapper = (children: ReactNode) => ReactNode;

/**
 * Mounts `hook` in a probe component and exposes what it returns. Updates the
 * hook causes are flushed by wrapping the trigger in `act`, or by awaiting
 * `act(async () => …)` when a promise has to settle first.
 */
export function renderHook<R>(hook: () => R, wrapper?: Wrapper): HookHandle<void, R>;
export function renderHook<P, R>(
  hook: (props: P) => R,
  initialProps: NoInfer<P>,
  wrapper?: Wrapper,
): HookHandle<P, R>;
export function renderHook<P, R>(
  hook: (props: P) => R,
  propsOrWrapper?: P | Wrapper,
  maybeWrapper?: Wrapper,
): HookHandle<P, R> {
  const hasProps = maybeWrapper !== undefined || typeof propsOrWrapper !== "function";
  const wrapper = hasProps ? maybeWrapper : (propsOrWrapper as Wrapper | undefined);
  let props = (hasProps ? propsOrWrapper : undefined) as P;

  const sink = { current: undefined as R, renders: 0 };
  function Probe({ value }: { value: P }) {
    sink.current = hook(value);
    sink.renders += 1;
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const draw = () => {
    const probe = createElement(Probe, { value: props });
    root.render(wrapper ? wrapper(probe) : probe);
  };
  act(draw);

  return {
    result: {
      get current() {
        return sink.current;
      },
    },
    renders: () => sink.renders,
    rerender(next: P) {
      props = next;
      act(draw);
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}
