// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/types';
import { fake } from '../test/fakeClient';
import { act, renderHook } from '../test/renderHook';
import { useSessionTitle } from './useSessionTitle';

vi.mock('../lib/client', async () => ({ client: (await import('../test/fakeClient')).fake.client }));

function session(id: string, kind: Session['kind'] = 'terminal'): Session {
  return {
    id,
    workspaceId: 'w1',
    kind,
    name: id,
    provider: 'claude',
    model: '',
    providerSessionId: null,
    description: '',
    notifications: true,
    autonomy: 'ask',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
  };
}

type Props = { sessions: Session[]; adopt: (id: string, name: string) => void };

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

const asked = () => fake.sent('session_sync_title').map((params) => params.id);

beforeEach(() => {
  vi.useFakeTimers();
  fake.reset();
});
afterEach(() => vi.useRealTimers());

describe('useSessionTitle', () => {
  it('asks for the title of every terminal at once and adopts the new ones', async () => {
    const titles: Record<string, string | null> = { t1: 'Fix the build', t2: null };
    fake.respond('session_sync_title', ({ id }) => {
      if (id === 't3') throw new Error('gone');
      return titles[id as string] ?? null;
    });
    const adopt = vi.fn();
    const hook = renderHook(() =>
      useSessionTitle([session('t1'), session('a1', 'agent'), session('t2'), session('t3')], adopt),
    );
    await flush();

    expect(asked()).toEqual(['t1', 't2', 't3']);
    expect(adopt.mock.calls).toEqual([['t1', 'Fix the build']]);
    hook.unmount();
  });

  it('sweeps again every 15 seconds with the list as it is then', async () => {
    fake.respond('session_sync_title', () => null);
    const adopt = vi.fn();
    const hook = renderHook((props: Props) => useSessionTitle(props.sessions, props.adopt), {
      sessions: [session('t1')],
      adopt,
    });
    await flush();
    hook.rerender({ sessions: [session('t1'), session('t2')], adopt });
    await flush();
    expect(asked()).toEqual(['t1']);

    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(asked()).toEqual(['t1']);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(asked()).toEqual(['t1', 't1', 't2']);
    hook.unmount();
  });

  it('starts over when the adopter changes, dropping answers meant for the old one', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const hook = renderHook((props: Props) => useSessionTitle(props.sessions, props.adopt), {
      sessions: [session('t1')],
      adopt: first,
    });
    const stale = fake.take('session_sync_title');
    hook.rerender({ sessions: [session('t1')], adopt: second });

    stale.resolve('Old title');
    fake.take('session_sync_title').resolve('New title');
    await flush();

    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls).toEqual([['t1', 'New title']]);
    hook.unmount();
  });

  it('stops sweeping on unmount and ignores answers still in flight', async () => {
    const adopt = vi.fn();
    const hook = renderHook(() => useSessionTitle([session('t1')], adopt));
    const pending = fake.take('session_sync_title');
    hook.unmount();

    pending.resolve('Late title');
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(adopt).not.toHaveBeenCalled();
    expect(asked()).toEqual(['t1']);
  });
});
