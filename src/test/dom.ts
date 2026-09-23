import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./renderHook";

export type Mounted = {
  container: HTMLElement;
  rerender(node: ReactNode): void;
  unmount(): void;
};

/** Mounts a component for an interaction test. The file runs under happy-dom. */
export function mount(node: ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender(next) {
      act(() => root.render(next));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

type KeyInit = Partial<Pick<KeyboardEventInit, "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "repeat">>;

/** Dispatches keydown (and keyup) the way a browser would, inside act. Returns whether default was prevented. */
export function press(target: EventTarget, key: string, init: KeyInit = {}): boolean {
  let prevented = false;
  act(() => {
    const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(down);
    prevented = down.defaultPrevented;
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...init }));
  });
  return prevented;
}

type MouseInit = Partial<Pick<MouseEventInit, "button" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "clientX" | "clientY">>;

export function click(target: EventTarget, init: MouseInit = {}) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

export function dispatch(target: EventTarget, event: Event) {
  act(() => {
    target.dispatchEvent(event);
  });
}

/**
 * Sets an input's or textarea's value through the native setter, so React's
 * onChange sees it, then fires `input`.
 */
export function type(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The one element matching `selector`; throws when there are none or several. */
export function only<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelectorAll<E>(selector);
  if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
  return found[0] as E;
}
