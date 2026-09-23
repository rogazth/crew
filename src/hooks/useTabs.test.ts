// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../lib/types';
import { deferred } from '../test/deferred';
import { fake } from '../test/fakeClient';
import { act, renderHook } from '../test/renderHook';
import { useTabs } from './useTabs';

vi.mock('../lib/client', async () => ({ client: (await import('../test/fakeClient')).fake.client }));

const tab = (sessionId: string): Tab => ({ id: `session:${sessionId}`, kind: 'session', sessionId });
const file: Tab = { id: 'file:/r/a.ts', kind: 'file', path: '/r/a.ts', relative: 'a.ts' };
const stub: Tab = { id: 'stub:terminal', kind: 'stub', stub: 'terminal', title: 'Terminal' };

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function answer(value: string | null) {
  fake.take('state_get').resolve(value);
  await settle();
}

const saved = (tabs: Tab[], activeId: string | null) => JSON.stringify({ tabs, activeId });

async function mounted(workspaceId: string | null = 'w1', stored: string | null = null) {
  const hook = renderHook((id: string | null) => useTabs(id), workspaceId);
  if (workspaceId) await answer(stored);
  return hook;
}

/** The last value written for `key`, parsed. */
function persisted(key = 'tabs:w1') {
  const value = fake.sent('state_set').filter((params) => params.key === key).at(-1)?.value;
  return value === undefined ? undefined : (JSON.parse(value as string) as unknown);
}

const tabIds = (tabs: Tab[]) => tabs.map((t) => t.id);

beforeEach(() => {
  fake.reset();
  fake.respond('state_set', () => undefined);
});

describe('useTabs restoring', () => {
  it('restores the saved tabs and the active one', async () => {
    const hook = renderHook(() => useTabs('w1'));
    expect(fake.sent('state_get')).toEqual([{ key: 'tabs:w1' }]);
    expect(hook.result.current.tabs).toEqual([]);
    expect(hook.result.current.active).toBeNull();

    await answer(saved([tab('a'), file], file.id));

    expect(hook.result.current.tabs).toEqual([tab('a'), file]);
    expect(hook.result.current.active).toEqual(file);
    hook.unmount();
  });

  it.each([
    ['nothing saved', null],
    ['a corrupt value', '{not json'],
    ['a value of the wrong shape', JSON.stringify({ tabs: 'nope' })],
  ])('opens with no tabs when there is %s', async (_, stored) => {
    const hook = await mounted('w1', stored);
    expect(hook.result.current.tabs).toEqual([]);
    act(() => hook.result.current.open(stub));
    expect(tabIds(hook.result.current.tabs)).toEqual([stub.id]);
    hook.unmount();
  });

  it('drops saved tabs that no longer parse and keeps the rest', async () => {
    const hook = await mounted('w1', JSON.stringify({ tabs: [tab('a'), { id: 'x', kind: 'nope' }], activeId: 'x' }));
    expect(hook.result.current.tabs).toEqual([tab('a')]);
    expect(hook.result.current.active).toEqual(tab('a'));
    hook.unmount();
  });

  it('opens with no tabs when the read fails, and writes none over the saved ones', async () => {
    const hook = renderHook((id: string) => useTabs(id), 'w1');
    fake.take('state_get').reject(new Error('down'));
    await settle();
    act(() => hook.result.current.open(stub));
    await settle();
    expect(tabIds(hook.result.current.tabs)).toEqual([stub.id]);
    expect(fake.sent('state_set')).toEqual([]);
    hook.unmount();
  });

  it('reads a failed workspace again when it is shown, then puts the saved tabs first', async () => {
    const hook = renderHook((id: string) => useTabs(id), 'w1');
    fake.take('state_get').reject(new Error('down'));
    await settle();
    act(() => hook.result.current.open(tab('b')));
    act(() => hook.result.current.open(stub));

    hook.rerender('w2');
    await answer(null);
    hook.rerender('w1');
    expect(fake.sent('state_get')).toEqual([{ key: 'tabs:w1' }, { key: 'tabs:w2' }, { key: 'tabs:w1' }]);
    await answer(saved([tab('a'), tab('b')], 'session:a'));

    expect(tabIds(hook.result.current.tabs)).toEqual(['session:a', 'session:b', stub.id]);
    expect(hook.result.current.active).toEqual(stub);
    expect(persisted()).toEqual({ tabs: [tab('a'), tab('b'), stub], activeId: stub.id });
    hook.unmount();
  });

  it('retries a failed read on reconnect and keeps the live tabs if it fails again', async () => {
    const reads = [deferred<string | null>(), deferred<string | null>(), deferred<string | null>()];
    let next = 0;
    fake.respond('state_get', () => reads[next++]?.promise);
    const hook = renderHook(() => useTabs('w1'));
    await act(async () => reads[0]?.reject(new Error('down')));
    await settle();
    act(() => hook.result.current.open(stub));

    fake.reconnect();
    await act(async () => reads[1]?.reject(new Error('still down')));
    await settle();
    expect(tabIds(hook.result.current.tabs)).toEqual([stub.id]);

    fake.reconnect();
    // The user closes what they opened while the read is in flight: nothing on screen.
    act(() => hook.result.current.close(stub.id));
    await act(async () => reads[2]?.resolve(saved([tab('a'), tab('b')], 'session:b')));
    await settle();

    expect(fake.sent('state_get')).toHaveLength(3);
    expect(tabIds(hook.result.current.tabs)).toEqual(['session:a', 'session:b']);
    expect(hook.result.current.active?.id).toBe('session:b');
    expect(persisted()).toEqual({ tabs: [tab('a'), tab('b')], activeId: 'session:b' });
    hook.unmount();
  });

  it('asks once while a retry is in flight', async () => {
    const retry = deferred<string | null>();
    const hook = renderHook((id: string) => useTabs(id), 'w1');
    fake.take('state_get').reject(new Error('down'));
    await settle();
    fake.respond('state_get', () => retry.promise);

    fake.reconnect();
    hook.rerender('w2');
    hook.rerender('w1');
    fake.reconnect();
    expect(fake.sent('state_get').filter((params) => params.key === 'tabs:w1')).toHaveLength(2);

    await act(async () => retry.resolve(saved([file], file.id)));
    await settle();
    expect(hook.result.current.tabs).toEqual([file]);
    hook.unmount();
  });

  it('never reads a workspace again after a read succeeds', async () => {
    const hook = await mounted('w1', saved([stub], stub.id));
    hook.rerender('w2');
    await answer(null);
    hook.rerender('w1');
    fake.reconnect();
    await settle();
    expect(fake.sent('state_get')).toEqual([{ key: 'tabs:w1' }, { key: 'tabs:w2' }]);
    expect(hook.result.current.tabs).toEqual([stub]);
    hook.unmount();
  });

  it('reads nothing and ignores every action without a workspace', () => {
    const hook = renderHook(() => useTabs(null));
    act(() => hook.result.current.open(stub));
    expect(fake.sent('state_get')).toEqual([]);
    expect(fake.sent('state_set')).toEqual([]);
    expect(hook.result.current.tabs).toEqual([]);
    expect(hook.result.current.panes).toEqual([]);
    hook.unmount();
  });

  it('ignores actions until the saved tabs are in', () => {
    const hook = renderHook(() => useTabs('w1'));
    act(() => hook.result.current.open(stub));
    expect(hook.result.current.tabs).toEqual([]);
    expect(fake.sent('state_set')).toEqual([]);
    hook.unmount();
  });

  it('files a late read under its own workspace, not the one on screen', async () => {
    const hook = renderHook((id: string) => useTabs(id), 'w1');
    const first = fake.take('state_get');
    hook.rerender('w2');

    first.resolve(saved([tab('a')], 'session:a'));
    await settle();
    expect(hook.result.current.tabs).toEqual([]);
    expect(hook.result.current.panes).toEqual([
      { id: 'w1/session:a', workspaceId: 'w1', tab: tab('a'), visible: false },
    ]);

    await answer(saved([stub], stub.id));
    expect(hook.result.current.tabs).toEqual([stub]);
    hook.unmount();
  });

  it('keeps the live tabs when a second read of the workspace lands', async () => {
    const hook = renderHook((id: string) => useTabs(id), 'w1');
    const first = fake.take('state_get');
    act(() => hook.result.current.dropWorkspace('w1'));
    hook.rerender('w2');
    await answer(null);
    hook.rerender('w1');
    const second = fake.take('state_get');

    first.resolve(saved([tab('a')], 'session:a'));
    await settle();
    second.resolve(saved([file], file.id));
    await settle();

    expect(hook.result.current.tabs).toEqual([tab('a')]);
    hook.unmount();
  });
});

describe('useTabs persistence', () => {
  it('writes the tabs back after every change, without the reopen stack', async () => {
    const hook = await mounted('w1', saved([tab('a')], 'session:a'));
    expect(persisted()).toEqual({ tabs: [tab('a')], activeId: 'session:a' });

    act(() => hook.result.current.open(file));
    expect(persisted()).toEqual({ tabs: [tab('a'), file], activeId: file.id });

    act(() => hook.result.current.close(file.id));
    expect(persisted()).toEqual({ tabs: [tab('a')], activeId: 'session:a' });
    hook.unmount();
  });

  it('shrugs off a failed write', async () => {
    fake.respond('state_set', () => {
      throw new Error('disk full');
    });
    const hook = await mounted('w1');
    act(() => hook.result.current.open(stub));
    await settle();
    expect(tabIds(hook.result.current.tabs)).toEqual([stub.id]);
    hook.unmount();
  });

  it('writes nothing for an action that changes nothing', async () => {
    const hook = await mounted('w1', saved([tab('a')], 'session:a'));
    const writes = fake.sent('state_set').length;
    act(() => hook.result.current.select('session:a'));
    act(() => hook.result.current.close('missing'));
    expect(fake.sent('state_set')).toHaveLength(writes);
    hook.unmount();
  });
});

describe('useTabs actions', () => {
  it('opens a tab once and brings it to the front', async () => {
    const hook = await mounted();
    act(() => hook.result.current.open(tab('a')));
    act(() => hook.result.current.open(stub));
    act(() => hook.result.current.open(tab('a')));
    expect(tabIds(hook.result.current.tabs)).toEqual(['session:a', stub.id]);
    expect(hook.result.current.active).toEqual(tab('a'));
    hook.unmount();
  });

  it('closes a tab, focuses its neighbour and reopens it', async () => {
    const hook = await mounted('w1', saved([tab('a'), tab('b'), tab('c')], 'session:b'));
    act(() => hook.result.current.close('session:b'));
    expect(tabIds(hook.result.current.tabs)).toEqual(['session:a', 'session:c']);
    expect(hook.result.current.active?.id).toBe('session:c');

    act(() => hook.result.current.reopen());
    expect(tabIds(hook.result.current.tabs)).toEqual(['session:a', 'session:c', 'session:b']);
    expect(hook.result.current.active?.id).toBe('session:b');

    act(() => hook.result.current.reopen());
    expect(tabIds(hook.result.current.tabs)).toEqual(['session:a', 'session:c', 'session:b']);
    hook.unmount();
  });

  it('closes a deleted session tab without offering it for reopening', async () => {
    const hook = await mounted('w1', saved([tab('a'), tab('b')], 'session:a'));
    act(() => hook.result.current.closeForSession('a'));
    expect(tabIds(hook.result.current.tabs)).toEqual(['session:b']);
    expect(hook.result.current.active?.id).toBe('session:b');
    act(() => hook.result.current.reopen());
    expect(tabIds(hook.result.current.tabs)).toEqual(['session:b']);
    hook.unmount();
  });

  it('steps through the strip, wrapping at both ends', async () => {
    const hook = await mounted('w1', saved([tab('a'), tab('b'), tab('c')], 'session:a'));
    act(() => hook.result.current.step(-1));
    expect(hook.result.current.active?.id).toBe('session:c');
    act(() => hook.result.current.step(1));
    expect(hook.result.current.active?.id).toBe('session:a');
    hook.unmount();
  });

  it('activates by position, the last one for -1', async () => {
    const hook = await mounted('w1', saved([tab('a'), tab('b'), tab('c')], 'session:a'));
    act(() => hook.result.current.activate(1));
    expect(hook.result.current.active?.id).toBe('session:b');
    act(() => hook.result.current.activate(-1));
    expect(hook.result.current.active?.id).toBe('session:c');
    act(() => hook.result.current.activate(9));
    expect(hook.result.current.active?.id).toBe('session:c');
    hook.unmount();
  });

  it('selects a tab by id, or none', async () => {
    const hook = await mounted('w1', saved([tab('a'), tab('b')], 'session:a'));
    act(() => hook.result.current.select('session:b'));
    expect(hook.result.current.active?.id).toBe('session:b');
    act(() => hook.result.current.select(null));
    expect(hook.result.current.active).toBeNull();
    expect(persisted()).toEqual({ tabs: [tab('a'), tab('b')], activeId: null });
    hook.unmount();
  });

  it('aims every action at the workspace on screen and keeps the others mounted', async () => {
    const hook = await mounted('w1', saved([stub], stub.id));
    hook.rerender('w2');
    await answer(saved([stub, tab('b')], 'session:b'));

    act(() => hook.result.current.close(stub.id));

    expect(tabIds(hook.result.current.tabs)).toEqual(['session:b']);
    expect(hook.result.current.panes).toEqual([
      { id: 'w1/stub:terminal', workspaceId: 'w1', tab: stub, visible: false },
      { id: 'w2/session:b', workspaceId: 'w2', tab: tab('b'), visible: true },
    ]);
    expect(persisted('tabs:w1')).toEqual({ tabs: [stub], activeId: stub.id });
    expect(persisted('tabs:w2')).toEqual({ tabs: [tab('b')], activeId: 'session:b' });
    hook.unmount();
  });

  it('drops a removed workspace and reads it again if it comes back', async () => {
    const hook = await mounted('w1', saved([stub], stub.id));
    hook.rerender('w2');
    await answer(null);

    act(() => hook.result.current.dropWorkspace('w1'));
    expect(hook.result.current.panes).toEqual([]);
    const before = hook.result.current.panes;
    act(() => hook.result.current.dropWorkspace('never-read'));
    expect(hook.result.current.panes).toBe(before);

    hook.rerender('w1');
    await answer(saved([file], file.id));
    expect(hook.result.current.tabs).toEqual([file]);
    expect(fake.sent('state_get')).toEqual([{ key: 'tabs:w1' }, { key: 'tabs:w2' }, { key: 'tabs:w1' }]);
    hook.unmount();
  });
});
