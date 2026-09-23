// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forget, read } from '../lib/transcript';
import type { Session, Tab } from '../lib/types';
import { fake } from '../test/fakeClient';
import { act, renderHook } from '../test/renderHook';
import type { useConfirmations } from './useConfirmations';
import { useNavigation } from './useNavigation';
import type { useTabs } from './useTabs';

vi.mock('../lib/client', async () => ({ client: (await import('../test/fakeClient')).fake.client }));

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

const sessionTab = (id: string): Tab => ({ id: `session:${id}`, kind: 'session', sessionId: id });

function setup(open: Tab[] = [], sessions: Session[] = []) {
  const calls: string[] = [];
  const tabs: ReturnType<typeof useTabs> = {
    tabs: open,
    active: open[0] ?? null,
    panes: [],
    open: vi.fn((tab: Tab) => void calls.push(`open ${tab.id}`)),
    close: vi.fn((id: string) => void calls.push(`close ${id}`)),
    closeForSession: vi.fn((id: string) => void calls.push(`closeForSession ${id}`)),
    reopen: vi.fn(),
    step: vi.fn(),
    activate: vi.fn(),
    select: vi.fn(),
    dropWorkspace: vi.fn(),
  };
  let pending: (() => void) | null = null;
  const confirms: ReturnType<typeof useConfirmations> = {
    confirm: null,
    ask: vi.fn(),
    askCloseTab: vi.fn((_: Session, onConfirm: () => void) => {
      pending = onConfirm;
    }),
    askSession: vi.fn(),
    askSessions: vi.fn(),
    askWorkspace: vi.fn(),
    close: vi.fn(),
  };
  const removeSession = vi.fn(async (id: string) => void calls.push(`remove ${id}`));
  const closePage = vi.fn(() => void calls.push('closePage'));
  const hook = renderHook(() => useNavigation({ tabs, sessions, confirms, removeSession, closePage }));
  /** Confirms the prompt closeTab raised and lets the disposability check land. */
  const confirm = async () => {
    await act(async () => {
      pending?.();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  };
  return { hook, tabs, confirms, removeSession, closePage, calls, confirm };
}

beforeEach(() => fake.reset());
afterEach(() => forget('hit'));

describe('useNavigation', () => {
  it('leaves the page before running a tab action', () => {
    const { hook, calls } = setup();
    const run = hook.result.current.inTabs(() => calls.push('act'));
    expect(calls).toEqual([]);
    run();
    expect(calls).toEqual(['closePage', 'act']);
    hook.unmount();
  });

  it('opens a session in its tab, over whatever page is up', () => {
    const { hook, calls, tabs } = setup();
    hook.result.current.openSession(session('a'));
    expect(calls).toEqual(['closePage', 'open session:a']);
    expect(tabs.open).toHaveBeenCalledWith({ id: 'session:a', kind: 'session', sessionId: 'a' });
    hook.unmount();
  });

  it('opens a session by id, and ignores an id it does not know', () => {
    const { hook, calls } = setup([], [session('a')]);
    hook.result.current.openSessionById('ghost');
    expect(calls).toEqual([]);
    hook.result.current.openSessionById('a');
    expect(calls).toEqual(['closePage', 'open session:a']);
    hook.unmount();
  });

  it('opens a search hit and takes the transcript to its line', async () => {
    fake.respond('transcript_tail', () => ({
      blocks: [
        { id: 'b1', role: 'user', text: 'one' },
        { id: 'b2', role: 'assistant', text: 'two' },
      ],
      fromPos: 1,
      toPos: 2,
      more: false,
      working: false,
      status: 'idle',
      seq: 0,
    }));
    const { hook, calls } = setup([], [session('hit', { kind: 'agent' })]);
    await act(async () => {
      hook.result.current.openHit('hit', 2);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(calls).toEqual(['closePage', 'open session:hit']);
    expect(fake.sent('transcript_tail')).toEqual([{ sessionId: 'hit', limit: 80 }]);
    expect(read('hit').focusId).toBe('b2');
    hook.unmount();
  });

  it('opens a file tab labelled with its relative path', () => {
    const { hook, calls, tabs } = setup();
    const file = { path: '/r/src/a.ts', relative: 'src/a.ts' };
    hook.result.current.openFile({ name: 'a.ts', ...file });
    expect(calls).toEqual(['closePage', 'open file:/r/src/a.ts']);
    expect(tabs.open).toHaveBeenCalledWith({ id: 'file:/r/src/a.ts', kind: 'file', ...file });
    hook.unmount();
  });

  it('opens a stub tab', () => {
    const { hook, calls, tabs } = setup();
    hook.result.current.openStub('browser', 'Browser');
    expect(calls).toEqual(['closePage', 'open stub:browser']);
    expect(tabs.open).toHaveBeenCalledWith({ id: 'stub:browser', kind: 'stub', stub: 'browser', title: 'Browser' });
    hook.unmount();
  });

  it('closes a tab that holds no session without asking', () => {
    const file: Tab = { id: 'file:/a', kind: 'file', path: '/a', relative: 'a' };
    const { hook, calls, confirms } = setup([file, sessionTab('gone')]);
    hook.result.current.closeTab('file:/a');
    hook.result.current.closeTab('session:gone');
    hook.result.current.closeTab('unknown');
    expect(calls).toEqual(['close file:/a', 'close session:gone', 'close unknown']);
    expect(confirms.askCloseTab).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('asks before closing a session tab, then deletes a disposable session with it', async () => {
    fake.respond('session_is_disposable', () => true);
    const target = session('a');
    const { hook, calls, confirms, confirm } = setup([sessionTab('a')], [target]);
    hook.result.current.closeTab('session:a');
    expect(confirms.askCloseTab).toHaveBeenCalledWith(target, expect.any(Function));
    expect(calls).toEqual([]);

    await confirm();
    expect(fake.sent('session_is_disposable')).toEqual([{ id: 'a' }]);
    expect(calls).toEqual(['closeForSession a', 'remove a']);
    hook.unmount();
  });

  it('only closes the tab of a session worth keeping', async () => {
    fake.respond('session_is_disposable', () => false);
    const { hook, calls, confirm } = setup([sessionTab('a')], [session('a')]);
    hook.result.current.closeTab('session:a');
    await confirm();
    expect(calls).toEqual(['close session:a']);
    hook.unmount();
  });

  it('keeps the session when the daemon cannot say whether it is disposable', async () => {
    fake.respond('session_is_disposable', () => {
      throw new Error('down');
    });
    const { hook, calls, removeSession, confirm } = setup([sessionTab('a')], [session('a')]);
    hook.result.current.closeTab('session:a');
    await confirm();
    expect(calls).toEqual(['close session:a']);
    expect(removeSession).not.toHaveBeenCalled();
    hook.unmount();
  });
});
