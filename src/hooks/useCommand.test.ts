// @vitest-environment happy-dom
import { detectPlatform } from '@tanstack/react-hotkeys';
import { describe, expect, it, vi } from 'vitest';
import { listedCommands, runCommand, type CommandId } from '../lib/commands';
import { press } from '../test/dom';
import { renderHook } from '../test/renderHook';
import { useCommand, useCommands } from './useCommand';

/** ⌘ on a Mac, Ctrl elsewhere: the `Mod` the bindings are written with. */
const mod = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };

type Map = { [K in CommandId]?: () => void };

describe('useCommand', () => {
  it('runs from the palette while mounted, and not after', () => {
    const handler = vi.fn();
    const hook = renderHook(() => useCommand('toggle-sidebar', handler));
    expect(listedCommands().map((c) => c.id)).toContain('toggle-sidebar');
    expect(runCommand('toggle-sidebar')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    hook.unmount();
    expect(runCommand('toggle-sidebar')).toBe(false);
    expect(listedCommands().map((c) => c.id)).not.toContain('toggle-sidebar');
  });

  it('runs from its keys while mounted, and not after', () => {
    const handler = vi.fn();
    const hook = renderHook(() => useCommand('toggle-sidebar', handler));
    press(document.body, 'b', mod);
    expect(handler).toHaveBeenCalledTimes(1);
    hook.unmount();
    press(document.body, 'b', mod);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs the latest handler without rebinding', () => {
    const first = vi.fn();
    const second = vi.fn();
    // Props go in an object: renderHook takes a bare function for a wrapper.
    const hook = renderHook(({ handler }: { handler: () => void }) => useCommand('new-session', handler), {
      handler: first,
    });
    hook.rerender({ handler: second });
    runCommand('new-session');
    press(document.body, 'n', mod);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('drops auto-repeat for a command that should fire once per press', () => {
    const handler = vi.fn();
    const hook = renderHook(() => useCommand('new-session', handler));
    press(document.body, 'n', { ...mod, repeat: true });
    expect(handler).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('lets tab cycling repeat while the keys are held', () => {
    const handler = vi.fn();
    const hook = renderHook(() => useCommand('next-tab', handler));
    press(document.body, ']', { ...mod, shiftKey: true });
    press(document.body, ']', { ...mod, shiftKey: true, repeat: true });
    expect(handler).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});

describe('useCommands', () => {
  it('registers only the commands that have a handler', () => {
    const palette = vi.fn();
    // The type forbids it; a map built at runtime can still carry an empty slot.
    const map = { 'open-palette': palette, 'go-to-file': undefined } as unknown as Map;
    const hook = renderHook(() => useCommands(map));
    expect(runCommand('go-to-file')).toBe(false);
    expect(runCommand('open-palette')).toBe(true);
    press(document.body, 'k', mod);
    expect(palette).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('rebinds when the set of commands changes', () => {
    const settings = vi.fn();
    const routines = vi.fn();
    const hook = renderHook((map: Map) => useCommands(map), { 'open-settings': settings });
    hook.rerender({ 'open-routines': routines });
    expect(runCommand('open-settings')).toBe(false);
    expect(runCommand('open-routines')).toBe(true);
    press(document.body, 'r', { ...mod, shiftKey: true });
    expect(routines).toHaveBeenCalledTimes(2);
    expect(settings).not.toHaveBeenCalled();
    hook.unmount();
  });
});
