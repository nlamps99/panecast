import type { EventFrame } from '../../protocol/frames';
import { isInboxEvent, parseInboxEvent, requiresUserInput, syntheticNeedsInputId } from '../inboxRecord';

const event = (category: string, name: string, payload: unknown): EventFrame => ({ type: 'event', category, name, payload });

let localIds = 0;
const newLocalId = () => `local-${++localIds}`;
const parse = (frame: EventFrame) => parseInboxEvent(frame, newLocalId);

beforeEach(() => {
  localIds = 0;
});

// Cases from relay/Tests/SharedKitTests/InboxNotificationTests.swift.
describe('SharedKit InboxNotification parity', () => {
  it('builds a record from a partial notification event', () => {
    const record = parse(
      event('notification', 'notification.created', { id: 'n-partial', workspace_id: 'w1', message: '새 알림이 도착했습니다.' }),
    );
    expect(record).toEqual({
      id: 'n-partial',
      idSource: 'payload',
      workspaceId: 'w1',
      surfaceId: null,
      title: 'cmux 通知',
      subtitle: null,
      body: '새 알림이 도착했습니다.',
      ts: null,
      needsInput: false,
    });
  });

  it('builds a needs-input record with a stable synthetic id', () => {
    const frame = (ts: number) =>
      event('hook', 'codex.permission_prompt', {
        workspace_id: 'w2',
        surface_id: 's2',
        source: 'Codex',
        message: 'approval required',
        ts,
      });
    const first = parse(frame(42));
    const second = parse(frame(99));
    expect(first?.id).toBe('needs-input-codex-permission-prompt-w2-s2-Codex-needs-input-approval-required');
    expect(second?.id).toBe(first?.id);
    expect(first).toMatchObject({
      idSource: 'content',
      title: 'Codex 需要你回应',
      body: 'approval required',
      surfaceId: 's2',
      needsInput: true,
    });
  });

  it('ignores generic workspace approval noise', () => {
    const frame = event('workspace', 'workspace.updated', { workspace_id: 'w3', source: 'billing', message: 'approval required' });
    expect(isInboxEvent(frame)).toBe(false);
    expect(parse(frame)).toBeNull();
  });
});

// Cases from legacy/ios/CmuxRemoteTests/StoresTests.swift.
describe('native client cases', () => {
  it('takes a complete NotificationRecord payload as is', () => {
    const record = parse(
      event('notification', 'notification.created', {
        id: 'n1',
        workspace_id: 'w1',
        surface_id: 's1',
        title: '작업 완료',
        subtitle: '요술마켓',
        body: '테스트가 끝났습니다.',
        ts: 42,
        thread_id: 'th1',
      }),
    );
    expect(record).toEqual({
      id: 'n1',
      idSource: 'payload',
      workspaceId: 'w1',
      surfaceId: 's1',
      title: '작업 완료',
      subtitle: '요술마켓',
      body: '테스트가 끝났습니다.',
      ts: 42,
      needsInput: false,
    });
  });

  it('keeps an explicit id on a needs-input event', () => {
    const record = parse(
      event('surface', 'claude.needs_input', { id: 'need-1', workspace_id: 'w1', surface_id: 's1', title: 'Claude Code', body: 'needs input' }),
    );
    expect(record).toMatchObject({ id: 'need-1', idSource: 'payload', title: 'Claude Code', body: 'needs input', needsInput: true });
    expect(requiresUserInput(event('surface', 'claude.needs_input', { body: 'needs input' }))).toBe(true);
  });

  it('dedupes a needs-input event without an id, from camelCase fields in an unknown category', () => {
    const frame = event('something-new', 'surface.needs-input', {
      workspaceId: 'w1',
      surfaceId: 's1',
      source: 'Claude Code',
      status: 'needs input',
    });
    const record = parse(frame);
    expect(record).toMatchObject({
      id: 'needs-input-surface-needs-input-w1-s1-Claude-Code-needs-input-needs-input',
      idSource: 'content',
      workspaceId: 'w1',
      surfaceId: 's1',
      title: 'Claude Code 需要你回应',
      body: 'needs input',
    });
    expect(parse(frame)?.id).toBe(record?.id);
  });

  it('reads a nested details.message and the bare workspace / surface keys', () => {
    const record = parse(
      event('unknown', 'notification', {
        workspace: 'w2',
        surface: 's2',
        details: { message: 'Claude Code needs your attention' },
      }),
    );
    expect(record).toMatchObject({
      workspaceId: 'w2',
      surfaceId: 's2',
      title: 'Claude Code 需要你回应',
      body: 'Claude Code needs your attention',
      needsInput: true,
    });
  });

  it('labels a hook needs-input event without a known agent as cmux', () => {
    const record = parse(event('hook', 'surface.needs-input', { workspace_id: 'w5', message: 'needs input' }));
    expect(record).toMatchObject({
      // SharedKit's title is "cmux hook needs input"; the empty surface collapses into one dash.
      id: 'needs-input-surface-needs-input-w5-cmux-hook-needs-input-needs-input',
      title: 'cmux 需要你回应',
      body: 'needs input',
    });
  });

  it('ignores events that are neither notifications nor waiting agents', () => {
    expect(parse(event('workspace', 'workspace.updated', { id: 'w1' }))).toBeNull();
    expect(parse(event('workspace', 'workspace.renamed', { id: 'w1' }))).toBeNull();
    // An agent says it needs input, but the phrase is not one SharedKit knows.
    expect(parse(event('agent', 'agent.idle', { source: 'claude', message: 'done' }))).toBeNull();
  });
});

describe('field fallbacks', () => {
  it('reads alternative spellings in SharedKit order', () => {
    const record = parse(
      event('notification', 'notification.created', {
        workspaceID: 'w9',
        surfaceID: 's9',
        headline: 'Build',
        summary: 'green',
        workspaceTitle: 'proj',
        notificationId: 'nid',
      }),
    );
    expect(record).toMatchObject({ id: 'nid', workspaceId: 'w9', surfaceId: 's9', title: 'Build', body: 'green', subtitle: 'proj' });
  });

  it('prefers snake_case keys over camelCase ones and skips empty strings', () => {
    const record = parse(
      event('notification', 'notification.created', {
        id: '',
        event_id: 'e1',
        workspace_id: 'snake',
        workspaceId: 'camel',
        title: '',
        body: '',
        reason: 'the reason',
      }),
    );
    expect(record).toMatchObject({ id: 'e1', workspaceId: 'snake', title: 'cmux 通知', body: 'the reason' });
  });

  it('walks the body fallbacks down to details.body', () => {
    const at = (payload: Record<string, unknown>) =>
      parse(event('notification', 'notification.created', { id: 'x', ...payload }))?.body;
    expect(at({ status: 's', prompt: 'p' })).toBe('s');
    expect(at({ prompt: 'p' })).toBe('p');
    expect(at({ details: { message: 'm', body: 'b' } })).toBe('m');
    expect(at({ details: { body: 'b' } })).toBe('b');
    expect(at({ details: 'not an object' })).toBe('');
  });

  it('takes the id from details.id, and makes one up for a plain notification without any', () => {
    expect(parse(event('notification', 'notification.created', { details: { id: 'deep' } }))?.id).toBe('deep');
    const record = parse(event('notification', 'notification.created', { title: 'x' }));
    expect(record).toMatchObject({ id: 'local-1', idSource: 'local' });
    expect(parse(event('notification', 'notification.created', { title: 'x' }))?.id).toBe('local-2');
  });

  it('does not use a numeric id', () => {
    expect(parse(event('notification', 'notification.created', { id: 7, title: 'x' }))?.idSource).toBe('local');
  });

  it('reads ts as an integer, a truncated double or an integer string', () => {
    const ts = (value: unknown) => parse(event('notification', 'notification.created', { id: 'x', ts: value }))?.ts;
    expect(ts(1_700_000_000)).toBe(1_700_000_000);
    expect(ts(12.9)).toBe(12);
    expect(ts('42')).toBe(42);
    expect(ts('1.5')).toBeNull();
    expect(ts('soon')).toBeNull();
    expect(ts(undefined)).toBeNull();
  });

  it('drops a body that only repeats the title', () => {
    expect(parse(event('notification', 'notification.created', { id: 'x', title: 'Done' }))?.body).toBe('');
    expect(parse(event('notification', 'notification.created', { id: 'x', title: 'Done', body: 'Done' }))?.body).toBe('');
  });

  it('uses the event name as the title of other notification events', () => {
    expect(parse(event('notification', 'notification.cleared', { id: 'x' }))?.title).toBe('notification.cleared');
  });

  it('needs an object payload', () => {
    expect(parse(event('notification', 'notification.created', null))).toBeNull();
    expect(parse(event('notification', 'notification.created', ['a']))).toBeNull();
    expect(parse(event('notification', 'notification.created', 'text'))).toBeNull();
  });

  it('treats the NotificationRecord shape as a decode only when every required field has the right type', () => {
    const full = { id: 'n', workspace_id: 'w', title: 't', body: 'b', ts: 5, thread_id: 'th', workspace_title: 'proj' };
    // Decoded: the record has no subtitle, so workspace_title is not used.
    expect(parse(event('notification', 'notification.created', full))?.subtitle).toBeNull();
    // Missing thread_id: the field-by-field fallback reads workspace_title.
    const { thread_id: _threadId, ...partial } = full;
    expect(parse(event('notification', 'notification.created', partial))?.subtitle).toBe('proj');
    // A fractional ts fails the decode too.
    expect(parse(event('notification', 'notification.created', { ...full, ts: 5.5 }))?.subtitle).toBe('proj');
    // camelCase keys decode as well.
    expect(
      parse(event('notification', 'notification.created', { id: 'n', workspaceId: 'w', title: 't', body: 'b', ts: 5, threadId: 'th', subtitle: 'sub' }))
        ?.subtitle,
    ).toBe('sub');
    // A surface id of the wrong type fails the decode; the fallback ignores it.
    expect(parse(event('notification', 'notification.created', { ...full, surface_id: 3 }))).toMatchObject({ surfaceId: null, subtitle: 'proj' });
  });
});

describe('needs-input detection', () => {
  const needs = (category: string, name: string, payload: unknown) => requiresUserInput(event(category, name, payload));

  it('needs both a phrase and a known agent, unless the event says needs input outright', () => {
    expect(needs('agent', 'tool.used', { source: 'claude', message: 'approval required' })).toBe(true);
    expect(needs('agent', 'tool.used', { message: 'approval required' })).toBe(false);
    expect(needs('agent', 'tool.used', { message: 'needs input' })).toBe(true);
    expect(needs('hook', 'x.needs_input', { message: 'needs your approval' })).toBe(true);
    expect(needs('hook', 'x', { model: 'gpt-codex', message: 'waiting-for-your-input' })).toBe(true);
    expect(needs('hook', 'x', { message: 'Permission_Prompt', agent: 'OpenAI' })).toBe(true);
  });

  it('searches nested string leaves', () => {
    expect(needs('agent', 'tick', { meta: [{ who: 'Claude' }], deep: { deeper: { text: 'Needs your attention' } } })).toBe(true);
  });

  it('names the agent in the title', () => {
    const title = (category: string, payload: Record<string, unknown>) =>
      parse(event(category, 'agent.waiting', { workspace_id: 'w', ...payload }))?.title;
    expect(title('agent', { source: 'Codex', message: 'needs input' })).toBe('Codex 需要你回应');
    expect(title('agent', { source: 'OpenAI', message: 'needs input' })).toBe('OpenAI 需要你回应');
    expect(title('agent', { message: 'needs input' })).toBe('智能体需要你回应');
    expect(title('system', { message: 'needs input' })).toBe('cmux 需要你回应');
  });

  it('survives a deeply nested payload', () => {
    let deep: unknown = 'claude needs input';
    for (let i = 0; i < 10_000; i++) deep = { next: deep };
    expect(() => requiresUserInput(event('agent', 'x', deep))).not.toThrow();
  });
});

describe('syntheticNeedsInputId', () => {
  it('keeps letters and digits of any script and collapses everything else into single dashes', () => {
    expect(syntheticNeedsInputId('hook.ask', 'w', null, 'Claude Code', '要不要继续？ é')).toBe(
      'needs-input-hook-ask-w-Claude-Code-要不要继续-é',
    );
    expect(syntheticNeedsInputId('--x--', 'w', 's', '🎉', '')).toBe('needs-input-x-w-s');
  });

  it('cuts the slug to 96 characters, keeping combining marks with their letter', () => {
    const id = syntheticNeedsInputId('n', 'w', 's', 'a'.repeat(200), '');
    expect(id).toBe(`needs-input-n-w-s-${'a'.repeat(90)}`);
    const marked = syntheticNeedsInputId('n', 'w', 's', `${'a'.repeat(89)}ézzz`, '');
    expect(marked).toBe(`needs-input-n-w-s-${'a'.repeat(89)}é`);
  });
});
