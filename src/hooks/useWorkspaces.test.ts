// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../lib/types';
import { fake } from '../test/fakeClient';
import { act, renderHook } from '../test/renderHook';
import { useWorkspaces } from './useWorkspaces';

vi.mock('../lib/client', async () => ({ client: (await import('../test/fakeClient')).fake.client }));

const ws = (id: string): Workspace => ({ id, name: id, path: `/code/${id}`, createdAt: 0 });

const pick = vi.fn<(opts: { directory?: boolean; multiple?: boolean }) => Promise<string | string[] | null>>();

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function mounted(list: Workspace[], active: string | null = list[0]?.id ?? null) {
  const hook = renderHook(() => useWorkspaces());
  fake.take('workspace_list').resolve(list);
  fake.take('active_workspace_get').resolve(active);
  await settle();
  return hook;
}

beforeEach(() => {
  fake.reset();
  for (const method of [
    'active_workspace_set',
    'workspace_rename',
    'workspace_delete',
    'workspace_reorder',
  ]) {
    fake.respond(method, () => undefined);
  }
  pick.mockReset();
  window.crewHost = { open: pick } as unknown as NonNullable<Window['crewHost']>;
});

afterEach(() => {
  delete window.crewHost;
});

describe('useWorkspaces loading', () => {
  it('loads the list and the active workspace', async () => {
    const hook = renderHook(() => useWorkspaces());
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.active).toBeNull();

    fake.take('workspace_list').resolve([ws('a'), ws('b')]);
    fake.take('active_workspace_get').resolve('b');
    await settle();

    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.workspaces).toEqual([ws('a'), ws('b')]);
    expect(hook.result.current.active).toEqual(ws('b'));
    hook.unmount();
  });

  it('falls back to the first workspace when the saved one is gone', async () => {
    const hook = await mounted([ws('a'), ws('b')], 'deleted');
    expect(hook.result.current.active).toEqual(ws('a'));
    hook.unmount();
  });

  it('has no active workspace when there are none', async () => {
    const hook = await mounted([], null);
    expect(hook.result.current.active).toBeNull();
    expect(hook.result.current.loading).toBe(false);
    hook.unmount();
  });

  it('reports a failed load', async () => {
    const hook = renderHook(() => useWorkspaces());
    fake.take('workspace_list').reject(new Error('daemon down'));
    fake.take('active_workspace_get').resolve(null);
    await settle();
    expect(hook.result.current.error).toBe('Error: daemon down');
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.workspaces).toEqual([]);
    hook.unmount();
  });

  it('drops a load that lands after unmount', async () => {
    const hook = renderHook(() => useWorkspaces());
    const list = fake.take('workspace_list');
    const active = fake.take('active_workspace_get');
    hook.unmount();
    const renders = hook.renders();
    list.resolve([ws('a')]);
    active.resolve('a');
    await settle();
    expect(hook.renders()).toBe(renders);
  });

  it('drops a failure that lands after unmount', async () => {
    const hook = renderHook(() => useWorkspaces());
    const list = fake.take('workspace_list');
    hook.unmount();
    const renders = hook.renders();
    list.reject(new Error('late'));
    await settle();
    expect(hook.renders()).toBe(renders);
  });
});

describe('useWorkspaces actions', () => {
  it('activates a workspace and tells the daemon', async () => {
    const hook = await mounted([ws('a'), ws('b')]);
    act(() => hook.result.current.activate('b'));
    expect(hook.result.current.active).toEqual(ws('b'));
    expect(fake.sent('active_workspace_set')).toEqual([{ id: 'b' }]);
    hook.unmount();
  });

  it('opens a picked folder as a new workspace named after it', async () => {
    const hook = await mounted([ws('a')]);
    pick.mockResolvedValue('/Users/me/code/furry/');
    fake.respond('workspace_create', ({ name, path }) => ({ id: 'n', name, path, createdAt: 1 }));

    await act(async () => hook.result.current.create());
    await settle();

    expect(pick).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(fake.sent('workspace_create')).toEqual([{ name: 'furry', path: '/Users/me/code/furry/' }]);
    expect(hook.result.current.workspaces.map((w) => w.id)).toEqual(['a', 'n']);
    expect(hook.result.current.active?.id).toBe('n');
    expect(fake.sent('active_workspace_set')).toEqual([{ id: 'n' }]);
    hook.unmount();
  });

  it.each([
    ['the picker is cancelled', null],
    ['the picker hands back several paths', ['/a', '/b']],
  ])('creates nothing when %s', async (_, picked) => {
    const hook = await mounted([ws('a')]);
    pick.mockResolvedValue(picked);
    await act(async () => hook.result.current.create());
    expect(fake.sent('workspace_create')).toEqual([]);
    expect(hook.result.current.workspaces).toEqual([ws('a')]);
    hook.unmount();
  });

  it('reports a refused create and clears it on the next success', async () => {
    const hook = await mounted([ws('a')]);
    pick.mockResolvedValue('/code/dup');
    fake.respond('workspace_create', () => {
      throw new Error('exists');
    });
    await act(async () => hook.result.current.create());
    expect(hook.result.current.error).toBe('Error: exists');
    expect(hook.result.current.workspaces).toEqual([ws('a')]);

    fake.respond('workspace_create', () => ws('dup'));
    await act(async () => hook.result.current.create());
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.workspaces).toEqual([ws('a'), ws('dup')]);
    hook.unmount();
  });

  it('renames on screen before the daemon answers', async () => {
    fake.reset();
    const hook = await mounted([ws('a'), ws('b')]);
    let renamed: Promise<void> = Promise.resolve();
    act(() => {
      renamed = hook.result.current.rename('a', 'Alpha');
    });
    expect(hook.result.current.workspaces.map((w) => w.name)).toEqual(['Alpha', 'b']);
    expect(fake.sent('workspace_rename')).toEqual([{ id: 'a', name: 'Alpha' }]);
    fake.take('workspace_rename').resolve(undefined);
    await expect(renamed).resolves.toBeUndefined();
    hook.unmount();
  });

  it('removes the active workspace after the daemon does, and moves to the first left', async () => {
    fake.reset();
    fake.respond('active_workspace_set', () => undefined);
    const hook = await mounted([ws('a'), ws('b'), ws('c')], 'b');
    act(() => void hook.result.current.remove('b'));
    expect(fake.sent('workspace_delete')).toEqual([{ id: 'b' }]);
    expect(hook.result.current.workspaces).toHaveLength(3);

    fake.take('workspace_delete').resolve(undefined);
    await settle();
    expect(hook.result.current.workspaces.map((w) => w.id)).toEqual(['a', 'c']);
    expect(hook.result.current.active?.id).toBe('a');
    expect(fake.sent('active_workspace_set')).toEqual([{ id: 'a' }]);
    hook.unmount();
  });

  it('keeps the active workspace when another one is removed', async () => {
    const hook = await mounted([ws('a'), ws('b')], 'a');
    await act(async () => hook.result.current.remove('b'));
    expect(hook.result.current.workspaces).toEqual([ws('a')]);
    expect(hook.result.current.active?.id).toBe('a');
    expect(fake.sent('active_workspace_set')).toEqual([]);
    hook.unmount();
  });

  it('has nothing active once the last workspace is removed', async () => {
    const hook = await mounted([ws('a')]);
    await act(async () => hook.result.current.remove('a'));
    expect(hook.result.current.active).toBeNull();
    expect(fake.sent('active_workspace_set')).toEqual([{ id: null }]);
    hook.unmount();
  });

  it('steps through the sidebar order and wraps', async () => {
    const hook = await mounted([ws('a'), ws('b'), ws('c')], 'a');
    act(() => hook.result.current.step(-1));
    expect(hook.result.current.active?.id).toBe('c');
    act(() => hook.result.current.step(1));
    expect(hook.result.current.active?.id).toBe('a');
    act(() => hook.result.current.step(1));
    expect(hook.result.current.active?.id).toBe('b');
    expect(fake.sent('active_workspace_set')).toEqual([{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
    hook.unmount();
  });

  it('steps from the first workspace when the active id is unknown', async () => {
    const hook = await mounted([ws('a'), ws('b'), ws('c')], 'a');
    act(() => hook.result.current.activate('ghost'));
    act(() => hook.result.current.step(1));
    expect(hook.result.current.active?.id).toBe('b');
    hook.unmount();
  });

  it('does not step with fewer than two workspaces', async () => {
    const hook = await mounted([ws('a')]);
    act(() => hook.result.current.step(1));
    expect(fake.sent('active_workspace_set')).toEqual([]);
    hook.unmount();
  });

  it('activates by position, skipping the active one and positions past the end', async () => {
    const hook = await mounted([ws('a'), ws('b')], 'a');
    act(() => hook.result.current.activateAt(1));
    expect(hook.result.current.active?.id).toBe('b');
    act(() => hook.result.current.activateAt(1));
    act(() => hook.result.current.activateAt(5));
    expect(fake.sent('active_workspace_set')).toEqual([{ id: 'b' }]);
    hook.unmount();
  });

  it('reorders and saves the order', async () => {
    const hook = await mounted([ws('a'), ws('b'), ws('c')]);
    act(() => hook.result.current.reorder(['c', 'a', 'b']));
    expect(hook.result.current.workspaces.map((w) => w.id)).toEqual(['c', 'a', 'b']);
    expect(fake.sent('workspace_reorder')).toEqual([{ ids: ['c', 'a', 'b'] }]);
    hook.unmount();
  });

  it('keeps the order when the new one leaves a workspace out', async () => {
    const hook = await mounted([ws('a'), ws('b'), ws('c')]);
    const before = hook.result.current.workspaces;
    act(() => hook.result.current.reorder(['c', 'ghost']));
    expect(hook.result.current.workspaces).toBe(before);
    hook.unmount();
  });
});
