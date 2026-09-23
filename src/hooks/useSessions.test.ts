// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentLabel } from '../lib/agentNames';
import { bindProviderSession } from '../lib/agentRuntime';
import type { Session } from '../lib/types';
import { deferred } from '../test/deferred';
import { fake } from '../test/fakeClient';
import { act, renderHook } from '../test/renderHook';
import { useSessions } from './useSessions';

vi.mock('../lib/client', async () => ({ client: (await import('../test/fakeClient')).fake.client }));

function session(id: string, workspaceId = 'w1', over: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId,
    kind: 'terminal',
    name: `name-${id}`,
    provider: 'claude',
    model: '',
    providerSessionId: null,
    description: '',
    notifications: true,
    autonomy: 'ask',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const input = { name: 'fresh', provider: 'claude', model: 'opus', description: 'd', autonomy: 'ask' as const };

/** Lets a chain of daemon answers land and React flush what they set. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function answer(method: string, value: unknown) {
  fake.take(method).resolve(value);
  await settle();
}

async function mounted(workspaceId: string | null = 'w1', list: Session[] = []) {
  const hook = renderHook((id: string | null) => useSessions(id), workspaceId);
  if (workspaceId) await answer('session_list', list);
  return hook;
}

const ids = (list: Session[]) => list.map((s) => s.id);

beforeEach(() => fake.reset());

describe('useSessions loading', () => {
  it('loads the workspace sessions and learns their names', async () => {
    const hook = renderHook(() => useSessions('w1'));
    expect(hook.result.current.sessions).toEqual([]);
    expect(fake.sent('session_list')).toEqual([{ workspaceId: 'w1' }]);

    await answer('session_list', [session('a', 'w1', { name: 'Alpha' }), session('b')]);

    expect(ids(hook.result.current.sessions)).toEqual(['a', 'b']);
    expect(ids(hook.result.current.all)).toEqual(['a', 'b']);
    expect(agentLabel('a')).toBe('Alpha');
    hook.unmount();
  });

  it('asks nothing and creates nothing without a workspace', async () => {
    const hook = renderHook(() => useSessions(null));
    expect(fake.sent('session_list')).toEqual([]);
    let created: Session | null = session('x');
    await act(async () => {
      created = await hook.result.current.create('terminal', input);
    });
    expect(created).toBeNull();
    act(() => hook.result.current.reorder(['a']));
    expect(fake.sent('session_create')).toEqual([]);
    expect(fake.sent('session_reorder')).toEqual([]);
    expect(hook.result.current.sessions).toEqual([]);
    hook.unmount();
  });

  it('keeps sessions created while the list was loading', async () => {
    const hook = renderHook(() => useSessions('w1'));
    let made: Promise<Session | null> = Promise.resolve(null);
    act(() => {
      made = hook.result.current.create('terminal', input);
    });
    await answer('session_create', session('c'));
    await expect(made).resolves.toEqual(session('c'));
    expect(ids(hook.result.current.sessions)).toEqual(['c']);

    await answer('session_list', [session('a')]);
    expect(ids(hook.result.current.sessions)).toEqual(['a', 'c']);
    hook.unmount();
  });

  it('does not duplicate a session the load already brought', async () => {
    const hook = renderHook(() => useSessions('w1'));
    act(() => void hook.result.current.create('terminal', input));
    await answer('session_create', session('c'));
    await answer('session_list', [session('a'), session('c')]);
    expect(ids(hook.result.current.sessions)).toEqual(['a', 'c']);
    hook.unmount();
  });

  it('reads a workspace once, however often it is shown', async () => {
    const hook = await mounted('w1', [session('a')]);
    hook.rerender('w2');
    await answer('session_list', [session('b', 'w2')]);
    hook.rerender('w1');
    await settle();
    expect(fake.sent('session_list')).toEqual([{ workspaceId: 'w1' }, { workspaceId: 'w2' }]);
    expect(ids(hook.result.current.sessions)).toEqual(['a']);
    hook.unmount();
  });

  it('retries a failed load the next time the workspace is selected', async () => {
    const hook = renderHook((id: string) => useSessions(id), 'w1');
    fake.take('session_list').reject(new Error('down'));
    await settle();
    expect(hook.result.current.sessions).toEqual([]);

    hook.rerender('w2');
    await answer('session_list', []);
    hook.rerender('w1');
    await answer('session_list', [session('a')]);

    expect(fake.sent('session_list')).toEqual([{ workspaceId: 'w1' }, { workspaceId: 'w2' }, { workspaceId: 'w1' }]);
    expect(ids(hook.result.current.sessions)).toEqual(['a']);
    hook.unmount();
  });

  it('files a late answer under its own workspace, not the one on screen', async () => {
    const hook = renderHook((id: string) => useSessions(id), 'w1');
    const first = fake.take('session_list');
    hook.rerender('w2');

    first.resolve([session('a')]);
    await settle();
    expect(hook.result.current.sessions).toEqual([]);
    expect(ids(hook.result.current.all)).toEqual(['a']);

    await answer('session_list', [session('b', 'w2')]);
    expect(ids(hook.result.current.sessions)).toEqual(['b']);
    hook.unmount();
  });
});

describe('useSessions events', () => {
  it('adds a session another window announced, once', async () => {
    const hook = await mounted('w1', [session('a')]);
    act(() => fake.emit('session-created', { session: session('a') }));
    act(() => fake.emit('session-created', { session: session('d', 'w1', { name: 'Delta' }) }));
    act(() => fake.emit('session-created', { session: session('d') }));
    expect(ids(hook.result.current.sessions)).toEqual(['a', 'd']);
    expect(agentLabel('d')).toBe('Delta');
    hook.unmount();
  });

  it('ignores an announced session of a workspace it has not loaded', async () => {
    const hook = await mounted('w1', [session('a')]);
    const before = hook.result.current.all;
    act(() => fake.emit('session-created', { session: session('z', 'w9') }));
    expect(hook.result.current.all).toBe(before);
    hook.unmount();
  });

  it('applies a runtime patch by id in whichever workspace holds the session', async () => {
    const hook = await mounted('w1', [session('a'), session('c')]);
    hook.rerender('w2');
    await answer('session_list', [session('b', 'w2')]);

    act(() => bindProviderSession('a', 'provider-a'));

    expect(hook.result.current.all.map((s) => s.providerSessionId)).toEqual(['provider-a', null, null]);
    expect(hook.result.current.sessions).toEqual([session('b', 'w2')]);
    hook.unmount();
  });

  it('leaves the list alone when a patch names an unknown session', async () => {
    const hook = await mounted('w1', [session('a')]);
    const before = hook.result.current.all;
    act(() => bindProviderSession('ghost', 'p'));
    expect(hook.result.current.all).toBe(before);
    hook.unmount();
  });

  it('stops listening on unmount', async () => {
    const hook = await mounted('w1', [session('a')]);
    expect(fake.listening('session-created')).toBe(1);
    hook.unmount();
    expect(fake.listening('session-created')).toBe(0);
  });
});

describe('useSessions actions', () => {
  it('creates a session in the workspace on screen', async () => {
    const hook = await mounted('w1', [session('a')]);
    let made: Promise<Session | null> = Promise.resolve(null);
    act(() => {
      made = hook.result.current.create('agent', input);
    });
    expect(fake.sent('session_create')).toEqual([{ workspaceId: 'w1', kind: 'agent', ...input }]);
    await answer('session_create', session('c', 'w1', { kind: 'agent' }));
    await expect(made).resolves.toMatchObject({ id: 'c' });
    expect(ids(hook.result.current.sessions)).toEqual(['a', 'c']);
    hook.unmount();
  });

  it('holds a new row back until the caller settles', async () => {
    const hook = await mounted('w1');
    const gate = deferred();
    act(() => void hook.result.current.create('terminal', input, gate.promise));
    await answer('session_create', session('c'));
    expect(hook.result.current.sessions).toEqual([]);
    await act(async () => gate.resolve());
    await settle();
    expect(ids(hook.result.current.sessions)).toEqual(['c']);
    hook.unmount();
  });

  it('updates a session once the daemon stored it and the caller settled', async () => {
    const hook = await mounted('w1', [session('a')]);
    const gate = deferred();
    const change = { ...input, notifications: false };
    act(() => void hook.result.current.update('a', change, gate.promise));
    expect(fake.sent('session_update')).toEqual([{ id: 'a', ...change }]);
    await answer('session_update', undefined);
    expect(hook.result.current.sessions[0]?.name).toBe('name-a');

    await act(async () => gate.resolve());
    await settle();
    expect(hook.result.current.sessions[0]).toMatchObject({ name: 'fresh', model: 'opus', notifications: false });
    hook.unmount();
  });

  it('renames after the daemon answers', async () => {
    const hook = await mounted('w1', [session('a')]);
    act(() => void hook.result.current.rename('a', 'Renamed'));
    expect(fake.sent('session_rename')).toEqual([{ id: 'a', name: 'Renamed' }]);
    expect(hook.result.current.sessions[0]?.name).toBe('name-a');
    await answer('session_rename', undefined);
    expect(hook.result.current.sessions[0]?.name).toBe('Renamed');
    expect(agentLabel('a')).toBe('Renamed');
    hook.unmount();
  });

  it('adopts a name the daemon already stored without asking again', async () => {
    const hook = await mounted('w1', [session('a')]);
    act(() => hook.result.current.adoptName('a', 'Adopted'));
    expect(hook.result.current.sessions[0]?.name).toBe('Adopted');
    expect(fake.sent('session_rename')).toEqual([]);
    hook.unmount();
  });

  it('stops a busy session before deleting it, then drops the row', async () => {
    const hook = await mounted('w1', [session('a', 'w1', { status: 'working' }), session('b')]);
    let gone: Promise<void> = Promise.resolve();
    act(() => {
      gone = hook.result.current.remove('a');
    });
    await answer('turn_stop', undefined);
    expect(fake.sent('turn_stop')).toEqual([{ sessionId: 'a' }]);
    expect(fake.sent('session_delete')).toEqual([{ id: 'a' }]);
    expect(ids(hook.result.current.sessions)).toEqual(['a', 'b']);

    await answer('session_delete', undefined);
    await gone;
    expect(ids(hook.result.current.sessions)).toEqual(['b']);
    hook.unmount();
  });

  it('deletes an idle session without stopping anything', async () => {
    const hook = await mounted('w1', [session('a')]);
    fake.respond('session_delete', () => undefined);
    await act(async () => hook.result.current.remove('a'));
    await settle();
    expect(fake.sent('turn_stop')).toEqual([]);
    expect(hook.result.current.sessions).toEqual([]);
    hook.unmount();
  });

  it('leaves the list alone when the deleted session was never listed', async () => {
    const hook = await mounted('w1', [session('a')]);
    fake.respond('session_delete', () => undefined);
    const before = hook.result.current.all;
    await act(async () => hook.result.current.remove('ghost'));
    expect(hook.result.current.all).toBe(before);
    hook.unmount();
  });

  it('reorders agents and keeps terminals after them', async () => {
    const list = [
      session('a1', 'w1', { kind: 'agent' }),
      session('a2', 'w1', { kind: 'agent' }),
      session('t1'),
      session('t2'),
    ];
    const hook = await mounted('w1', list);
    act(() => hook.result.current.reorder(['a2', 'a1', 'missing']));
    expect(ids(hook.result.current.sessions)).toEqual(['a2', 'a1', 't1', 't2']);
    expect(fake.sent('session_reorder')).toEqual([{ ids: ['a2', 'a1', 'missing'] }]);

    act(() => hook.result.current.reorder(['t2', 't1']));
    expect(ids(hook.result.current.sessions)).toEqual(['a2', 'a1', 't2', 't1']);
    hook.unmount();
  });

  it('keeps the order when the ids name nothing it holds', async () => {
    const hook = await mounted('w1', [session('a')]);
    const before = hook.result.current.sessions;
    act(() => hook.result.current.reorder([]));
    expect(fake.sent('session_reorder')).toEqual([]);
    act(() => hook.result.current.reorder(['ghost']));
    expect(hook.result.current.sessions).toBe(before);
    expect(fake.sent('session_reorder')).toEqual([{ ids: ['ghost'] }]);
    hook.unmount();
  });

  it('keeps the order when the workspace has not loaded yet', () => {
    const hook = renderHook(() => useSessions('w1'));
    act(() => hook.result.current.reorder(['a']));
    expect(hook.result.current.sessions).toEqual([]);
    expect(fake.sent('session_reorder')).toEqual([{ ids: ['a'] }]);
    hook.unmount();
  });

  it('shows a terminal status at once and tells the daemon, shrugging off a refusal', async () => {
    const hook = await mounted('w1', [session('a')]);
    fake.respond('session_set_status', () => {
      throw new Error('gone');
    });
    act(() => hook.result.current.setStatus('a', 'needs-input'));
    await settle();
    expect(hook.result.current.sessions[0]?.status).toBe('needs-input');
    expect(fake.sent('session_set_status')).toEqual([{ id: 'a', status: 'needs-input' }]);
    hook.unmount();
  });

  it('forgets a removed workspace and reads it again if it comes back', async () => {
    const hook = await mounted('w1', [session('a')]);
    hook.rerender('w2');
    await answer('session_list', []);

    act(() => hook.result.current.dropWorkspace('w1'));
    expect(hook.result.current.all).toEqual([]);
    const before = hook.result.current.all;
    act(() => hook.result.current.dropWorkspace('never-loaded'));
    expect(hook.result.current.all).toBe(before);

    hook.rerender('w1');
    await answer('session_list', [session('b')]);
    expect(ids(hook.result.current.sessions)).toEqual(['b']);
    hook.unmount();
  });
});
