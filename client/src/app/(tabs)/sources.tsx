import { router, useFocusEffect, useLocalSearchParams, usePathname } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SourceStore, type AgentRequest, type SourceInfo } from '../../session/sourceStore';
import { agentTimeline, type AgentTimelineRow } from '../../session/agentTimeline';
import { AgentMessage, AgentToolsSummary } from '../../ui/AgentConversationItem';
import { useConnectionStatus, useMachine, useStore } from '../../state/hooks';
import { ComputerSwitcher } from '../../ui/ComputerSwitcher';
import { DialogModal, NameDialog } from '../../ui/NameDialog';
import { colors, fonts } from '../../ui/theme';
import { sessionMemory } from '../../state/sessionMemory';
import { SourceNavigation } from '../../state/sourceNavigation';
import { conversationCache } from '../../session/conversationCache';

const modes = { terminal: '终端', history: '仅历史', attach: '共享会话服务', managed: '独立会话服务' };
const statuses = { online: '在线', offline: '离线', revoked: '未授权', unknown: '检查中' };

export default function SourcesScreen() {
  const machine = useMachine();
  return <SourcesContent key={machine.computer?.id ?? 'demo'} />;
}

function SourcesContent() {
  const machine = useMachine(), insets = useSafeAreaInsets();
  const computerId = machine.computer?.id ?? 'demo';
  const cache = useMemo(() => computerId === 'demo' ? undefined : conversationCache(computerId), [computerId]);
  const store = useMemo(() => new SourceStore(machine.channel, { cache }), [machine.channel, cache]);
  const state = useStore(store);
  const connection = useConnectionStatus(machine.channel);
  const source = state.sources.find((s) => s.id === state.sourceId);
  const [newConversation, setNewConversation] = useState(false);
  const routeParams = useLocalSearchParams<{ sourceId?: string; threadId?: string }>();
  const pathname = usePathname();
  const routeSourceId = typeof routeParams.sourceId === 'string' ? routeParams.sourceId : null;
  const routeThreadId = typeof routeParams.threadId === 'string' ? routeParams.threadId : null;
  const navigation = useMemo(() => new SourceNavigation(store), [store]);
  useEffect(() => () => { navigation.cancel(); store.dispose(); }, [store, navigation]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => { if (next !== 'active') void cache?.flush(); else void store.readThread(); });
    return () => listener.remove();
  }, [cache, store]);
  useFocusEffect(useCallback(() => { void store.refresh(); const timer = setInterval(() => void store.refresh(), 15_000); return () => clearInterval(timer); }, [store]));

  useEffect(() => {
    if (pathname !== '/sources' || state.supported !== true) return;
    const routeKey = `${computerId}:${routeSourceId ?? 'saved'}:${routeThreadId ?? ''}`;
    if (navigation.completed === routeKey) return;
    const saved = sessionMemory.computer(computerId).source;
    const sourceId = routeSourceId ?? saved?.sourceId;
    const threadId = routeSourceId ? routeThreadId : saved?.threadId;
    const found = state.sources.find((s) => s.id === sourceId);
    if (!found?.enabled || (found.status !== 'online' && !store.hasCachedSource(found.id))) return;
    void navigation.open(found.id, threadId, () => {
      const current = store.getState();
      if (current.sourceId) sessionMemory.rememberSource(computerId, { sourceId: current.sourceId, threadId: current.thread?.id ?? null });
      navigation.markCompleted(`${computerId}:saved:`);
      if (routeSourceId) router.setParams({ sourceId: undefined, threadId: undefined });
    }).catch(() => {});
    const taskVersion = navigation.version;
    return () => navigation.cancel(taskVersion);
  }, [computerId, pathname, connection.state, routeSourceId, routeThreadId, state.sources, state.supported, store, navigation]);

  useEffect(() => {
    if (pathname !== '/sources') return;
    const unsubscribe = store.subscribe(() => {
    if (navigation.active) return;
    const current = store.getState();
    if (current.sourceId) sessionMemory.rememberSource(computerId, { sourceId: current.sourceId, threadId: current.thread?.id ?? null });
    });
    return () => { unsubscribe(); };
  }, [computerId, pathname, store, navigation]);

  const open = async (item: SourceInfo) => {
    navigation.cancel(); navigation.markCompleted(`${computerId}:saved:`);
    const intent = navigation.version;
    if (routeSourceId) router.setParams({ sourceId: undefined, threadId: undefined });
    if (item.type === 'codex') { await store.selectSource(item.id); return; }
    await machine.workspaces.refresh();
    if (navigation.version !== intent) return;
    const window = machine.workspaces.getState().windows.find((w) => w.sourceId === item.id);
    if (window) await machine.workspaces.selectWindow(window.id);
    if (navigation.version !== intent) return;
    router.navigate('/');
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.screen, { paddingTop: insets.top + 12, paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{state.thread ? 'Codex 会话' : source ? source.name : '连接源'}</Text>
        {source ? <Button label="返回" onPress={() => { navigation.cancel(); navigation.markCompleted(`${computerId}:saved:`); if (routeSourceId) router.setParams({ sourceId: undefined, threadId: undefined }); if (state.thread) void store.selectSource(source.id); else { sessionMemory.rememberSource(computerId, null); void store.selectSource(null); } }} /> : <Button label="刷新" onPress={() => void store.refresh()} />}
      </View>
      <ComputerSwitcher />
      {connection.state !== 'open' ? <Text style={styles.warning}>正在连接电脑，恢复后才能操作</Text> : null}
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      {state.loading && !state.turns.length ? <ActivityIndicator color={colors.green} style={{ marginVertical: 8 }} /> : null}
      {!source ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.help}>一台电脑，一次配对。这里集中显示电脑端已配置的终端和 Codex 来源。</Text>
          {state.supported === false ? <Text style={styles.help}>当前连接使用单一终端 relay。安装统一网关后，这里会显示 cmux、tmux 和 Codex；已有终端仍可从工作区打开。</Text> : null}
          {state.supported && !state.sources.length ? <Text style={styles.help}>还没有配置连接源。请在电脑端添加并授权来源，然后刷新。</Text> : null}
          {state.sources.map((item) => (
            <Pressable key={item.id} onPress={() => void open(item)} disabled={!item.enabled || (item.status !== 'online' && !store.hasCachedSource(item.id))} style={styles.card} accessibilityRole="button" accessibilityLabel={`打开 ${item.name}`}>
              <View style={styles.row}><Text style={styles.cardTitle}>{item.name}</Text><Text style={{ color: item.status === 'online' ? colors.green : colors.muted }}>{item.status !== 'online' && store.hasCachedSource(item.id) ? '本机记录' : statuses[item.status]}</Text></View>
              <Text style={styles.meta}>{item.type} · {modes[item.mode]} · {item.capabilities.control && item.status === 'online' ? '可操作' : '只读'}</Text>
              {item.error ? <Text style={styles.error}>{item.error}</Text> : null}
            </Pressable>
          ))}
          <Text style={styles.help}>来源的读取、操作权限和撤销由电脑端管理。Codex 标为“仅历史”时，可以查看保存的对话；实时操作需要连接承载原会话的服务。</Text>
        </ScrollView>
      ) : state.thread ? (
        <Conversation key={`${source.id}:${state.thread.id}`} source={source} store={store} connected={connection.state === 'open'} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.row}><Text style={styles.meta}>{modes[source.mode]} · {source.capabilities.control ? '可操作' : '只读'}</Text><Button label="刷新" onPress={() => void store.loadThreads()} /></View>
          {source.capabilities.control ? <Button label="新建对话" disabled={state.busy || connection.state !== 'open' || source.status !== 'online'} onPress={() => { setNewConversation(true); void store.loadProjects(); }} /> : null}
          {!state.loading && !state.threads.length ? <Text style={styles.help}>没有可显示的会话</Text> : null}
          {state.threads.map((thread) => <Pressable key={thread.id} style={styles.card} onPress={() => { navigation.cancel(); navigation.markCompleted(`${computerId}:saved:`); if (routeSourceId) router.setParams({ sourceId: undefined, threadId: undefined }); void store.openThread(thread.id); }} accessibilityRole="button"><Text style={styles.cardTitle}>{thread.name}</Text><Text style={styles.meta} numberOfLines={2}>{thread.cwd}</Text><Text style={styles.meta}>{thread.live === false || thread.status?.type === 'history' ? '已保存的历史' : thread.status?.type === 'active' ? '正在运行 · 已连接' : thread.live ? '已连接 · 可继续' : thread.status?.type ?? '已保存'}</Text></Pressable>)}
          {state.threadCursor ? <Button label="更多会话" disabled={state.loading} onPress={() => void store.loadThreads(true)} /> : null}
        </ScrollView>
      )}
      {newConversation && source ? <NewConversation store={store} onClose={() => setNewConversation(false)} /> : null}
    </KeyboardAvoidingView>
  );
}

function Conversation({ source, store, connected }: { source: SourceInfo; store: SourceStore; connected: boolean }) {
  const state = useStore(store);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const inputRef = useRef<TextInputInstance>(null);
  const listRef = useRef<FlatList<AgentTimelineRow>>(null);
  const followInput = useRef(false);
  const followTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (followTimer.current) clearTimeout(followTimer.current); }, []);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(() => new Set());
  const active = state.activeTurnId;
  const liveControl = source.capabilities.control && state.thread?.live !== false;
  const canControl = connected && source.status === 'online' && liveControl && state.threadVerified && !state.busy && !state.loading;
  const rows = useMemo(() => agentTimeline(state.turns, expandedTools, active).reverse(), [state.turns, expandedTools, active]);
  return (
    <View style={styles.conversation}>
      <Text style={styles.cardTitle}>{state.thread?.name}</Text>
      <Text style={styles.meta} numberOfLines={2}>{state.thread?.cwd}</Text>
      {state.fromCache ? <Text style={styles.meta}>{state.loading && connected ? '已显示本机历史，正在更新最新消息…' : '当前显示本机历史'}</Text> : null}
      <View style={styles.row}>
        <Button label="刷新会话" onPress={() => void store.readThread()} disabled={!connected} />
        {source.capabilities.control ? <Button label="重命名" disabled={!canControl} onPress={() => setRenameOpen(true)} /> : null}
        {source.capabilities.control ? <Button label="归档" disabled={!canControl} onPress={() => setArchiveOpen(true)} /> : null}
        {active && source.capabilities.control ? <Button label="停止" disabled={!canControl} onPress={() => void store.action('agent.interrupt', { turn_id: active })} /> : null}
      </View>
      <FlatList
        ref={listRef}
        testID="codex-messages" style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
        data={rows} keyExtractor={(row) => row.key} initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5}
        inverted maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 60 }}
        onContentSizeChange={() => { if (followInput.current) listRef.current?.scrollToOffset({ offset: 0, animated: false }); }}
        onEndReached={() => { if (!state.historyError) void store.loadOlder(); }} onEndReachedThreshold={1.5}
        ListFooterComponent={<View style={styles.historyBoundary}>
          {state.historyLoading ? <ActivityIndicator color={colors.green} /> : null}
          {state.historyError ? <><Text style={styles.error}>{state.historyError}</Text><Button label="重试读取历史" disabled={!connected || state.historyLoading} onPress={() => void store.loadOlder()} /></>
            : state.historyCursor ? <Text style={styles.meta}>{connected ? '继续上滑，自动读取更早消息' : '连接后可继续读取更早消息'}</Text>
              : state.turns.length ? <Text style={styles.meta}>已到会话开头</Text> : null}
        </View>}
        renderItem={({ item: row }) => row.kind === 'item' ? <AgentMessage item={row.item} /> : row.kind === 'tools' ? <AgentToolsSummary group={row} onToggle={() => setExpandedTools((current) => {
          const next = new Set(current);
          if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
          return next;
        })} /> : <View style={{ gap: 6 }}>
          {row.turnId === active && liveControl ? <Text style={styles.meta}>正在执行…</Text> : null}
          {row.omitted > 0 ? <Text style={styles.meta}>还有 {row.omitted} 条较早的工具记录未加载，完整记录可在电脑查看。</Text> : null}
          {row.error ? <Text style={styles.error}>{row.error}</Text> : null}
        </View>}
        ListHeaderComponent={<View style={{ gap: 12 }}>
          {state.submissions.map((submission) => <View key={submission.id} style={[styles.message, styles.userMessage]}>
            <Text style={styles.meta}>你{submission.mode === 'steer' ? ' · 追加指令' : ''}</Text>
            <Text selectable style={styles.messageText}>{submission.text.slice(0, 4000)}</Text>
            <Text style={styles.meta}>{submission.status === 'sending' ? '正在发送…' : submission.status === 'unknown' ? '发送未确认，请先刷新会话检查' : 'Codex 已接收，等待写入对话'}</Text>
          </View>)}
          {state.requests.map((request) => <RequestCard key={request.id} request={request} store={store} enabled={canControl} />)}
        </View>}
        ListEmptyComponent={!state.loading ? <Text style={styles.help}>开始发送消息，与 Codex 一起处理这个项目。</Text> : undefined}
      />
      {state.submissions.length ? <Text style={styles.delivery} accessibilityLiveRegion="polite">{state.submissions.at(-1)?.status === 'accepted'
        ? state.submissions.at(-1)?.mode === 'steer' ? '已送达 Codex；追加内容会在当前步骤结束后处理' : '已送达 Codex，正在等待回复'
        : state.submissions.at(-1)?.status === 'unknown' ? '发送结果未确认，草稿已保留，请先刷新检查' : '正在发送到 Codex…'}</Text> : null}
      {liveControl ? <View style={styles.composer}>
        <TextInput ref={inputRef} multiline defaultValue="" onChangeText={(value) => { draftRef.current = value; setDraft(value); }} placeholder={active ? '追加指令…' : '给 Codex 发消息…'} placeholderTextColor={colors.muted} style={styles.input} accessibilityLabel="Codex 消息" />
        <Button label={state.busy ? '发送中…' : active ? '追加' : '发送'} disabled={!canControl || !draft.trim()} onPress={() => {
          const sent = draft;
          followInput.current = true;
          if (followTimer.current) clearTimeout(followTimer.current);
          void store.action(active ? 'agent.steer' : 'agent.send', { text: sent, ...(active ? { turn_id: active } : {}) }).then((ok) => {
            if (ok && draftRef.current === sent) { inputRef.current?.clear(); draftRef.current = ''; setDraft(''); }
            if (ok) listRef.current?.scrollToOffset({ offset: 0, animated: true });
            followTimer.current = setTimeout(() => { followInput.current = false; }, 300);
          });
        }} />
      </View> : source.capabilities.control ? <View style={styles.resume}>
        <Text style={styles.help}>继续这条已保存的对话，或基于它的历史开始一条新对话。</Text>
        <View style={styles.row}>
          <Button label={state.busy ? '正在连接…' : '继续对话'} disabled={!connected || !state.threadVerified || state.busy || state.loading} onPress={() => void store.action('agent.resume')} />
          <Button label="从历史新建" disabled={!connected || !state.threadVerified || state.busy || state.loading} onPress={() => void store.action('agent.fork')} />
        </View>
      </View> : <Text style={styles.help}>当前来源只读。请切换到已授权操作的 Codex 桌面来源来继续或新建对话。</Text>}
      {renameOpen ? <NameDialog visible title="重命名会话" initialValue={state.thread?.name} confirmLabel="保存" onCancel={() => setRenameOpen(false)} onSubmit={(name) => { setRenameOpen(false); void store.action('agent.rename', { name }); }} /> : null}
      <DialogModal visible={archiveOpen} placement="bottom" onDismiss={() => setArchiveOpen(false)}>
        <View style={styles.card}><Text style={styles.cardTitle}>归档这个会话？</Text><Text style={styles.help}>归档后可以在电脑上的 Codex 历史中找回。</Text><View style={styles.row}><Button label="取消" onPress={() => setArchiveOpen(false)} /><Button label="归档" disabled={!canControl} onPress={() => { setArchiveOpen(false); void store.action('agent.archive'); }} /></View></View>
      </DialogModal>
    </View>
  );
}

function NewConversation({ store, onClose }: { store: SourceStore; onClose(): void }) {
  const state = useStore(store);
  const [selected, setSelected] = useState<string | null>(null);
  const title = useRef('');
  const projectId = selected ?? state.projects[0]?.id;
  return <DialogModal visible placement="top" onDismiss={onClose}>
    <View style={styles.card}>
      <Text style={styles.cardTitle}>新建对话</Text>
      <Text style={styles.help}>选择电脑上的项目目录</Text>
      <TextInput defaultValue="" onChangeText={(value) => { title.current = value; }} placeholder="对话名称（可选）" placeholderTextColor={colors.muted} style={[styles.input, { flex: 0 }]} accessibilityLabel="对话名称" />
      {state.projectsLoading ? <ActivityIndicator color={colors.green} /> : null}
      <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled">
        {state.projects.map((project) => <Pressable key={project.id} onPress={() => setSelected(project.id)} style={[styles.project, project.id === projectId && styles.projectSelected]} accessibilityRole="button" accessibilityLabel={`选择项目 ${project.name}`}>
          <Text style={styles.cardTitle}>{project.id === projectId ? '✓ ' : ''}{project.name}</Text><Text numberOfLines={2} style={styles.meta}>{project.cwd}</Text>
        </Pressable>)}
      </ScrollView>
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      {!state.projectsLoading && !state.projects.length ? <Text style={styles.help}>没有可用目录，请刷新或在电脑端配置项目。</Text> : null}
      <View style={styles.row}><Button label="取消" onPress={onClose} /><Button label="创建对话" disabled={!projectId || state.projectsLoading || state.busy} onPress={() => {
        void store.action('agent.create', { project_id: projectId, ...(title.current.trim() ? { name: title.current.trim() } : {}) }).then((ok) => { if (ok) onClose(); });
      }} /></View>
    </View>
  </DialogModal>;
}

function RequestCard({ request, store, enabled }: { request: AgentRequest; store: SourceStore; enabled: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = request.params.questions ?? [];
  return <View style={styles.card}>
    <Text style={styles.cardTitle}>等待回应</Text>
    {request.params.reason ? <Text style={styles.messageText}>{request.params.reason}</Text> : null}
    {request.params.command ? <Text selectable style={styles.code}>{request.params.command}</Text> : null}
    {!request.supported ? <Text style={styles.help}>这个请求需要在电脑上的 Codex 中处理。</Text> : request.method === 'tool/requestUserInput' ? <>
      {questions.map((question) => <View key={question.id} style={{ gap: 6 }}><Text style={styles.messageText}>{question.question}</Text>
        {question.options?.map((option) => <Button key={option.label} label={`${answers[question.id] === option.label ? '✓ ' : ''}${option.label}${option.description ? ` · ${option.description}` : ''}`} disabled={!enabled} onPress={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))} />)}
        <TextInput style={styles.input} value={answers[question.id] ?? ''} onChangeText={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))} placeholder="输入回答" placeholderTextColor={colors.muted} accessibilityLabel={question.question} />
      </View>)}
      <Button label="提交回答" disabled={!enabled || questions.some((q) => !answers[q.id]?.trim())} onPress={() => void store.action('agent.respond', { request_id: request.id, answers: Object.fromEntries(questions.map((q) => [q.id, [answers[q.id]]])) })} />
    </> : <View style={styles.row}>
      <Button label="允许这次操作" disabled={!enabled} onPress={() => void store.action('agent.respond', { request_id: request.id, decision: 'accept' })} />
      <Button label="拒绝" disabled={!enabled} onPress={() => void store.action('agent.respond', { request_id: request.id, decision: 'decline' })} />
    </View>}
  </View>;
}

function Button({ label, onPress, disabled = false }: { label: string; onPress(): void; disabled?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} style={[styles.button, disabled && { opacity: 0.4 }]} accessibilityRole="button" accessibilityState={{ disabled }}><Text style={styles.buttonText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, title: { color: colors.ink, fontSize: 26, fontWeight: '700' },
  content: { paddingVertical: 12, paddingBottom: 24, gap: 12 }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  card: { backgroundColor: colors.surface, borderRadius: 14, padding: 16, gap: 10 }, cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.inkDim, fontSize: 12 }, help: { color: colors.inkDim, fontSize: 13, lineHeight: 21, paddingVertical: 6 },
  error: { color: colors.red, fontSize: 13, lineHeight: 20 }, warning: { color: colors.yellow, fontSize: 13 },
  button: { borderRadius: 8, backgroundColor: colors.surfaceRaised, paddingVertical: 10, paddingHorizontal: 12, alignSelf: 'flex-start', maxWidth: '100%' }, buttonText: { color: colors.green, fontSize: 13 },
  conversation: { flex: 1, gap: 8 }, message: { padding: 12, backgroundColor: colors.surface, borderRadius: 12, gap: 8 }, userMessage: { backgroundColor: colors.surfaceRaised },
  messageText: { color: colors.ink, fontSize: 14, lineHeight: 22 }, code: { color: colors.ink, fontFamily: fonts.mono, fontSize: 12, lineHeight: 19 },
  composer: { flexDirection: 'row', gap: 8, alignItems: 'flex-end', paddingVertical: 8 }, input: { flex: 1, minHeight: 44, maxHeight: 140, color: colors.ink, backgroundColor: colors.surface, borderRadius: 10, padding: 12, fontSize: 14 },
  resume: { gap: 6, paddingBottom: 12 }, project: { padding: 10, gap: 5, borderRadius: 10, marginBottom: 6 }, projectSelected: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.green },
  delivery: { color: colors.inkDim, fontSize: 12, lineHeight: 18, paddingTop: 6 },
  historyBoundary: { alignItems: 'center', gap: 8, paddingVertical: 12 },
});
