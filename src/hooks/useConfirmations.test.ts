// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBusy } from '../lib/terminalBusy';
import type { Session, Workspace } from '../lib/types';
import { act, renderHook } from '../test/renderHook';
import { runningLabel, useConfirmations } from './useConfirmations';

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: 'w1',
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

function setup() {
  const calls: string[] = [];
  const deps = {
    closeTabsFor: vi.fn((id: string) => void calls.push(`close ${id}`)),
    removeSession: vi.fn(async (id: string) => void calls.push(`remove ${id}`)),
    removeWorkspace: vi.fn((id: string) => void calls.push(`workspace ${id}`)),
  };
  const hook = renderHook(() => useConfirmations(deps));
  return { hook, deps, calls };
}

afterEach(() => setBusy('busy', false));

describe('runningLabel', () => {
  it('names the statuses that mean a process is still running', () => {
    expect(runningLabel('working')).toBe('is still working');
    expect(runningLabel('needs-input')).toBe('is waiting on you');
    expect(runningLabel('idle')).toBeNull();
    expect(runningLabel('done')).toBeNull();
  });
});

describe('useConfirmations', () => {
  it('starts with nothing to confirm', () => {
    const { hook } = setup();
    expect(hook.result.current.confirm).toBeNull();
    hook.unmount();
  });

  it('asks before deleting an agent, then closes its tabs before removing it', async () => {
    const { hook, calls } = setup();
    act(() => hook.result.current.askSession(session('a', { kind: 'agent', name: 'Planner' })));
    const confirm = hook.result.current.confirm;
    expect(confirm).toMatchObject({ title: 'Delete agent "Planner"?', action: 'Delete' });
    expect(calls).toEqual([]);

    await confirm?.onConfirm();
    expect(calls).toEqual(['close a', 'remove a']);
    hook.unmount();
  });

  it('calls a terminal a session', () => {
    const { hook } = setup();
    act(() => hook.result.current.askSession(session('t', { name: 'zsh' })));
    expect(hook.result.current.confirm?.title).toBe('Delete session "zsh"?');
    hook.unmount();
  });

  it('asks about a single selected session by its name', () => {
    const { hook } = setup();
    act(() => hook.result.current.askSessions([session('t', { name: 'zsh' })]));
    expect(hook.result.current.confirm?.title).toBe('Delete session "zsh"?');
    hook.unmount();
  });

  it('deletes several sessions behind one prompt, closing every tab first', async () => {
    const { hook, calls, deps } = setup();
    act(() => hook.result.current.askSessions([session('a'), session('b')]));
    expect(hook.result.current.confirm).toMatchObject({ title: 'Delete 2 items?', action: 'Delete' });

    await hook.result.current.confirm?.onConfirm();
    expect(calls).toEqual(['close a', 'close b', 'remove a', 'remove b']);
    expect(deps.removeSession).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('asks before removing a workspace', async () => {
    const { hook, calls } = setup();
    const workspace: Workspace = { id: 'w1', name: 'crew', path: '/code/crew', createdAt: 0 };
    act(() => hook.result.current.askWorkspace(workspace));
    expect(hook.result.current.confirm).toMatchObject({ title: 'Remove workspace "crew"?', action: 'Remove' });
    await hook.result.current.confirm?.onConfirm();
    expect(calls).toEqual(['workspace w1']);
    hook.unmount();
  });

  it('closes an agent tab without asking', () => {
    const { hook } = setup();
    const onConfirm = vi.fn();
    act(() => hook.result.current.askCloseTab(session('a', { kind: 'agent', status: 'working' }), onConfirm));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(hook.result.current.confirm).toBeNull();
    hook.unmount();
  });

  it('closes a quiet terminal tab without asking', () => {
    const { hook } = setup();
    const onConfirm = vi.fn();
    act(() => hook.result.current.askCloseTab(session('t'), onConfirm));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(hook.result.current.confirm).toBeNull();
    hook.unmount();
  });

  it.each([
    ['working', 'is still working'],
    ['needs-input', 'is waiting on you'],
  ] as const)('asks before closing a terminal that is %s', (status, label) => {
    const { hook } = setup();
    const onConfirm = vi.fn();
    act(() => hook.result.current.askCloseTab(session('t', { name: 'zsh', status }), onConfirm));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(hook.result.current.confirm).toEqual({
      title: 'Close "zsh"?',
      description: `It ${label}. Closing the tab ends the process; the session stays in the sidebar.`,
      action: 'Close',
      onConfirm,
    });
    hook.unmount();
  });

  it('asks before closing a watched terminal that is still running something', () => {
    const { hook } = setup();
    setBusy('busy', true);
    const onConfirm = vi.fn();
    act(() => hook.result.current.askCloseTab(session('busy'), onConfirm));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(hook.result.current.confirm?.description).toMatch(/^It is still working\./);
    hook.unmount();
  });

  it('shows any prompt handed to it and closes it', () => {
    const { hook } = setup();
    const prompt = { title: 'Sure?', description: 'Really.', action: 'Go', onConfirm: vi.fn() };
    act(() => hook.result.current.ask(prompt));
    expect(hook.result.current.confirm).toBe(prompt);
    act(() => hook.result.current.close());
    expect(hook.result.current.confirm).toBeNull();
    hook.unmount();
  });
});
