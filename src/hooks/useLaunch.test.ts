// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionKind } from '../lib/types';
import { fake } from '../test/fakeClient';
import { act, renderHook } from '../test/renderHook';
import { useDefaultAgent } from './useDefaultAgent';
import { useLaunch } from './useLaunch';

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

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

type CreateInput = { name: string; provider: string; model: string; description: string; autonomy: 'ask' | 'full' };

async function setup(sessions: Session[] = [], made: Session | null = session('new')) {
  const create = vi.fn(async (_kind: SessionKind, _input: CreateInput) => made);
  const openSession = vi.fn();
  const openStub = vi.fn();
  const newAgent = vi.fn();
  const hook = renderHook(() => ({
    launch: useLaunch({ sessions, create, openSession, openStub, newAgent }),
    agent: useDefaultAgent(),
  }));
  await settle();
  // The preferred agent is module state; set it through the hook that owns it.
  act(() => hook.result.current.agent.update({ provider: 'claude', model: 'opus' }));
  return { hook, create, openSession, openStub, newAgent };
}

beforeEach(() => {
  fake.reset();
  fake.respond('state_get', () => null);
  fake.respond('state_set', () => undefined);
  fake.respond('agent_installed', ({ names }) => names);
});

describe('useLaunch', () => {
  it('opens a new terminal on the default agent and its model, named after the provider', async () => {
    const { hook, create, openSession } = await setup();
    await act(async () => hook.result.current.launch.newSession());
    expect(create).toHaveBeenCalledWith('terminal', {
      name: 'claude',
      provider: 'claude',
      model: 'opus',
      description: '',
      autonomy: 'ask',
    });
    expect(openSession).toHaveBeenCalledWith(session('new'));
    hook.unmount();
  });

  it('numbers the name past the terminals already open', async () => {
    const { hook, create } = await setup([
      session('a', { name: 'claude' }),
      session('b', { name: 'claude 2' }),
      session('c', { name: 'claude 3', kind: 'agent' }),
    ]);
    await act(async () => hook.result.current.launch.newSession());
    expect(create.mock.calls[0]?.[1].name).toBe('claude 3');
    hook.unmount();
  });

  it('starts another provider on its CLI default model', async () => {
    const { hook, create } = await setup();
    await act(async () => hook.result.current.launch.newSession('codex'));
    expect(create.mock.calls[0]?.[1]).toMatchObject({ name: 'codex', provider: 'codex', model: '' });
    hook.unmount();
  });

  it('opens nothing when no session was made', async () => {
    const { hook, openSession } = await setup([], null);
    await act(async () => hook.result.current.launch.newSession());
    expect(openSession).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('routes each launcher pick', async () => {
    const { hook, create, openSession, openStub, newAgent } = await setup();
    const existing = session('old');

    act(() => hook.result.current.launch.launch({ kind: 'stub', stub: 'browser', title: 'Browser' }));
    expect(openStub).toHaveBeenCalledWith('browser', 'Browser');

    act(() => hook.result.current.launch.launch({ kind: 'new-agent' }));
    expect(newAgent).toHaveBeenCalledTimes(1);

    act(() => hook.result.current.launch.launch({ kind: 'session', session: existing }));
    expect(openSession).toHaveBeenLastCalledWith(existing);

    await act(async () => hook.result.current.launch.launch({ kind: 'new-session', provider: 'opencode' }));
    await settle();
    expect(create.mock.calls[0]?.[1]).toMatchObject({ provider: 'opencode' });
    expect(openSession).toHaveBeenLastCalledWith(session('new'));
    hook.unmount();
  });

  it('starts a picked new session on the default agent when it names no provider', async () => {
    const { hook, create } = await setup();
    await act(async () => hook.result.current.launch.launch({ kind: 'new-session' }));
    await settle();
    expect(create.mock.calls[0]?.[1]).toMatchObject({ provider: 'claude', model: 'opus' });
    hook.unmount();
  });
});
