// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBusy, setBusy } from '../lib/terminalBusy';
import type { Session, SessionStatus } from '../lib/types';
import { act, renderHook } from '../test/renderHook';
import { useSessionActivity } from './useSessionActivity';

function session(id = 't1', status: SessionStatus = 'idle'): Session {
  return {
    id,
    workspaceId: 'w1',
    kind: 'terminal',
    name: 'zsh',
    provider: 'claude',
    model: '',
    providerSessionId: null,
    description: '',
    notifications: true,
    autonomy: 'ask',
    status,
    createdAt: 0,
    updatedAt: 0,
  };
}

type Props = { session: Session; active: boolean };

/** Mounts the hook and returns the statuses it reported, in order. */
function setup(active: boolean, start: Session = session()) {
  const reported: SessionStatus[] = [];
  const onStatus = vi.fn((_: string, status: SessionStatus) => void reported.push(status));
  const hook = renderHook((props: Props) => useSessionActivity(props.session, props.active, onStatus), {
    session: start,
    active,
  });
  return { hook, reported, onStatus };
}

/** Past the settle window a tab switch leaves behind. */
const settled = () => act(() => vi.advanceTimersByTime(1001));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const id of ['t1', 't2']) setBusy(id, false);
});

describe('useSessionActivity', () => {
  it('clears a flagged tab to idle when it is opened', () => {
    const { hook, onStatus } = setup(true, session('t1', 'done'));
    expect(onStatus).toHaveBeenCalledWith('t1', 'idle');
    hook.unmount();
  });

  it('reports nothing for a watched tab that is already idle', () => {
    const { hook, reported } = setup(true);
    expect(reported).toEqual([]);
    hook.unmount();
  });

  it('marks background output as working, then done after a quiet spell', () => {
    const { hook, reported } = setup(false);
    settled();
    act(() => hook.result.current.onActivity());
    expect(reported).toEqual(['working']);
    expect(isBusy('t1')).toBe(true);

    act(() => vi.advanceTimersByTime(1000));
    act(() => hook.result.current.onActivity());
    act(() => vi.advanceTimersByTime(1499));
    expect(reported).toEqual(['working']);

    act(() => vi.advanceTimersByTime(1));
    expect(reported).toEqual(['working', 'done']);
    expect(isBusy('t1')).toBe(false);
    hook.unmount();
  });

  it('tracks a watched terminal as busy without flagging it', () => {
    const { hook, reported } = setup(true);
    act(() => hook.result.current.onActivity());
    expect(isBusy('t1')).toBe(true);
    act(() => vi.advanceTimersByTime(1500));
    expect(isBusy('t1')).toBe(false);
    expect(reported).toEqual([]);
    hook.unmount();
  });

  it('takes the repaint right after leaving a tab for the switch, not for work', () => {
    const { hook, reported } = setup(true);
    hook.rerender({ session: session(), active: false });
    act(() => vi.advanceTimersByTime(1000));
    act(() => hook.result.current.onActivity());
    expect(reported).toEqual([]);
    expect(isBusy('t1')).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    act(() => hook.result.current.onActivity());
    expect(reported).toEqual(['working']);
    hook.unmount();
  });

  it('does not flag work that finished while the tab came to the front', () => {
    const { hook, reported } = setup(false);
    settled();
    act(() => hook.result.current.onActivity());
    hook.rerender({ session: session(), active: true });
    act(() => vi.advanceTimersByTime(1500));
    expect(reported).toEqual(['working', 'idle']);
    hook.unmount();
  });

  it('flags a bell in the background as waiting on you, and keeps it through the redraw', () => {
    const { hook, reported } = setup(false);
    settled();
    act(() => hook.result.current.onActivity());
    act(() => hook.result.current.onBell());
    expect(reported).toEqual(['working', 'needs-input']);
    expect(isBusy('t1')).toBe(true);

    act(() => hook.result.current.onActivity());
    act(() => vi.advanceTimersByTime(1500));
    expect(reported).toEqual(['working', 'needs-input']);
    hook.unmount();
  });

  it('raises nothing for a bell on the tab you are watching', () => {
    const { hook, reported } = setup(true);
    act(() => hook.result.current.onBell());
    expect(reported).toEqual([]);
    expect(isBusy('t1')).toBe(true);
    hook.unmount();
  });

  it('reports a failed exit as an error and stops waiting for quiet', () => {
    const { hook, reported } = setup(false);
    settled();
    act(() => hook.result.current.onActivity());
    act(() => hook.result.current.onExit(1));
    expect(reported).toEqual(['working', 'error']);
    expect(isBusy('t1')).toBe(false);

    act(() => hook.result.current.onActivity());
    act(() => vi.advanceTimersByTime(1500));
    expect(reported).toEqual(['working', 'error']);
    hook.unmount();
  });

  it('reports a clean exit as done in the background and idle in front', () => {
    const background = setup(false);
    act(() => background.hook.result.current.onExit(0));
    expect(background.reported).toEqual(['done']);
    background.hook.unmount();

    const watched = setup(true, session('t2', 'working'));
    act(() => watched.hook.result.current.onExit(null));
    expect(watched.reported).toEqual(['idle']);
    watched.hook.unmount();
  });

  it('stops waiting and clears busy on unmount', () => {
    const { hook, reported } = setup(false);
    settled();
    act(() => hook.result.current.onActivity());
    hook.unmount();
    expect(isBusy('t1')).toBe(false);
    act(() => vi.advanceTimersByTime(1500));
    expect(reported).toEqual(['working']);
  });

  it('clears busy for the old session when it is given another', () => {
    const { hook } = setup(true);
    act(() => hook.result.current.onActivity());
    hook.rerender({ session: session('t2'), active: true });
    expect(isBusy('t1')).toBe(false);
    hook.unmount();
  });
});
