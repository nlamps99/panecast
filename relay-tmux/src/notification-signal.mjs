const REQUESTS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'tool/requestUserInput', 'item/tool/requestUserInput'];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value) => typeof value === 'string' ? value.trim().toLowerCase().replace(/[_-]/g, ' ') : '';
const matches = (value, pattern) => pattern.test(text(value));
/** Keep in sync with relay-tmux/src/notification-signal.mjs and SharedKit. */
export function notificationSignal(event) {
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
        return null;
    const p = object(event.payload), name = event.name;
    // Bookkeeping and individual tool/message updates are never milestones.
    if (/^notification\.(?!created$)/.test(name) || name === 'serverRequest/resolved')
        return null;
    if (REQUESTS.includes(name))
        return 'attention';
    if (/^(item\/|message[./]|tool[./])/.test(name) || /[./](delta|progress|started|updated)$/.test(name))
        return null;
    const notification = event.category === 'notification' || name === 'notification.created' || name === 'notification';
    const lifecycle = /^(task|turn|agent)[./](completed|failed|error|blocked|status|status_changed|waiting)$/.test(name);
    const inputEvent = /(^|[./])(needs[_-]input|permission_prompt|request_approval)$/.test(name);
    if (!notification && !lifecycle && !inputEvent && event.category !== 'hook' && name !== 'error')
        return null;
    const status = text(object(p.status).type ?? p.status ?? p.state ?? object(p.turn).status);
    if (['cancelled', 'canceled', 'interrupted', 'resolved', 'idle', 'running', 'in progress', 'inprogress', 'working', 'started', 'retrying'].includes(status))
        return null;
    if (p.willRetry === true || p.will_retry === true)
        return null;
    if (['failed', 'error', 'blocked', 'needs attention'].includes(status) || /[./](failed|error|blocked)$/.test(name) || name === 'error')
        return 'attention';
    if (['completed', 'complete', 'done', 'succeeded', 'success'].includes(status) || /^(task|turn|agent)[./]completed$/.test(name))
        return 'completed';
    if (p.needs_input === true || inputEvent || ['needs input', 'waiting for input', 'awaiting input', 'approval required', 'waiting for approval'].includes(status))
        return 'attention';
    // Legacy cmux hooks have only a short title/message. Do not search arbitrary
    // nested payloads or conversation prose for words like "done" or "approval".
    const title = p.title ?? p.headline;
    const message = p.body ?? p.message ?? object(p.details).message ?? object(p.details).body;
    const input = /^(?:(?:codex|claude(?: code)?|openai|agent|cmux)\s+)?(?:needs (?:input|attention|your (?:input|attention|approval))|input needed|waiting for your input|approval required|permission prompt|需要你回应|需要你确认|等待回应|需要审批|等待确认|需要回答|等待回答)[.!。！:：]?$/;
    if (matches(title, input) || matches(message, input))
        return 'attention';
    if (notification || event.category === 'hook') {
        const completed = /^(?:(?:task|turn|build|tests?|codex|claude(?: code)?)\s+)?(?:completed|complete|done|finished|succeeded|passed)(?:$|[.!:：])|^(?:任务|构建|测试|工作|本轮)(?:已)?完成(?:$|[。！!：:\s])|^测试(?:全部)?通过(?:$|[。！!：:\s])|^작업 완료$/;
        const problem = /^(?:(?:task|turn|build|tests?|codex|claude(?: code)?)\s+)?(?:failed|error|blocked)(?:$|[.!:：\s])|^(?:任务失败|构建失败|测试失败|任务阻塞|发生错误)(?:$|[。！!：:\s])/;
        if (matches(title, problem))
            return 'attention';
        if (matches(title, completed))
            return 'completed';
    }
    return null;
}
/** Stable across live delivery, replay, and a repeated lifecycle callback. */
export function lifecycleNotificationId(event) {
    const p = object(event.payload), signal = notificationSignal(event);
    const request = p.request_id ?? p.requestId;
    // The hub broadcasts both the conversation request and its inbox record.
    if (REQUESTS.includes(event.name) && typeof request === 'string' && request)
        return `request:${p.source_id ?? ''}:${request}`;
    const id = p.task_id ?? p.taskId ?? p.request_id ?? p.requestId ?? p.turn_id ?? p.turnId ?? object(p.turn).id;
    if (!signal || typeof id !== 'string' || !id)
        return null;
    return `task-event:${p.source_id ?? ''}:${p.thread_id ?? p.threadId ?? ''}:${id}:${signal}`;
}
