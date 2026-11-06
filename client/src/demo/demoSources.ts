import { RpcCallError } from '../protocol/connection';
import type { AgentThread, AgentTurn, SourceInfo } from '../session/sourceStore';

/** Offline examples only; never connect to Codex or run a command. */
export class DemoSources {
  private threads: AgentThread[] = [{ id: 'demo-agent-1', name: '检查统一网关的授权（演示）', cwd: '/demo/panecast', status: { type: 'idle' }, live: false }];
  private turns: Record<string, AgentTurn[]> = { 'demo-agent-1': [{ id: 'demo-turn-1', status: 'completed', items: [
    { id: 'demo-user-1', type: 'userMessage', content: [{ type: 'text', text: '帮我检查 cmux、tmux 和 Codex 是否按各自的授权工作。' }] },
    { id: 'demo-answer-1', type: 'agentMessage', text: '这是离线示例。三个来源可以共用一次配对；只读来源只能查看，操作权限由电脑端授予。Codex 历史来源不会自动接管桌面任务。' },
    { id: 'demo-change-1', type: 'fileChange', changes: [{ path: 'relay/sources.json', diff: '+ "access": "read"' }] },
  ] }] };
  private counter = 1;

  handle(method: string, p: Record<string, unknown>) {
    if (method === 'source.list') {
      const sources: SourceInfo[] = [
        { id: 'demo-terminal', name: '终端演示', type: 'cmux', enabled: true, access: 'control', status: 'online', mode: 'terminal', capabilities: { read: true, control: true, realtime: true, create: true } },
        { id: 'demo-codex', name: 'Codex 演示', type: 'codex', enabled: true, access: 'control', status: 'online', mode: 'managed', capabilities: { read: true, control: true, realtime: true, create: true } },
      ];
      return { sources };
    }
    if (p.source_id !== 'demo-codex') throw new RpcCallError('not_found', '找不到这个演示来源');
    if (method === 'agent.projects') return { projects: [{ id: 'demo-project', name: 'Panecast 演示项目', cwd: '/demo/panecast' }] };
    if (method === 'agent.threads') return { threads: this.threads, next_cursor: null };
    if (method === 'agent.create') {
      const thread = { id: `demo-agent-${++this.counter}`, name: typeof p.name === 'string' && p.name ? p.name : '新会话（演示）', cwd: '/demo/panecast', status: { type: 'idle' }, live: true };
      this.threads = [thread, ...this.threads]; this.turns[thread.id] = []; return { thread };
    }
    const thread = this.threads.find((t) => t.id === p.thread_id);
    if (!thread) throw new RpcCallError('not_found', '演示会话已归档');
    if (method === 'agent.pending') return { requests: [] };
    if (method === 'agent.subscribe') return { thread };
    if (method === 'agent.resume') { thread.live = true; return { thread }; }
    if (method === 'agent.fork') {
      const fork = { ...thread, id: `demo-agent-${++this.counter}`, name: `${thread.name}（新对话）`, live: true };
      this.threads = [fork, ...this.threads]; this.turns[fork.id] = [...this.turns[thread.id]]; return { thread: fork };
    }
    if (method === 'agent.read') return { thread, turns: this.turns[thread.id], next_cursor: null };
    if (method === 'agent.archive') { this.threads = this.threads.filter((t) => t.id !== thread.id); return {}; }
    if (method === 'agent.rename') { thread.name = String(p.name); return {}; }
    if (method === 'agent.send') {
      const id = String(++this.counter);
      this.turns[thread.id] = [...this.turns[thread.id], { id: `turn-${id}`, status: 'completed', items: [
        { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: String(p.text) }] },
        { id: `answer-${id}`, type: 'agentMessage', text: '已收到你的演示消息。连接真实 Codex 来源后，这里会显示实际回复、命令输出和文件改动。' },
      ] }];
      return {};
    }
    throw new RpcCallError('method_not_found', '演示不支持这个操作');
  }
}
