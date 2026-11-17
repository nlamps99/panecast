import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextStyle,
  type ScrollViewInstance,
} from 'react-native';
import { GestureDetector, useNativeGesture, usePinchGesture } from 'react-native-gesture-handler';

import type { TerminalSession, TerminalState } from '../session/terminalSession';
import { DEFAULT_ATTR } from '../terminal/ansi';
import { LayoutCache, terminalRowColumns, type Span, type VisualLine } from '../terminal/layout';
import { cellRuns } from '../terminal/cellRuns';
import { codePointWidth } from '../terminal/cellWidth';
import { desktopBridge } from '../platform/desktop';
import { TERMINAL_LINE_DATA, useTerminalCopy } from '../input/terminalCopy';
import { makeReadingPosition, positionedLines, restoredLineIndex, type PositionedLine, type ReadingPosition } from '../session/readingPosition';
import { DEFAULT_FG, styleForAttr } from '../terminal/palette';
import { clampFontSize, setPrefs, usePrefs } from '../state/prefs';
import { colors, fonts, MONO_ADVANCE_EM } from './theme';
import { TerminalTools } from './TerminalTools';
import { useTerminalWheel } from '../input/terminalWheel';

const SIDE_PADDING = 8;

export function terminalColumns(width: number, fontSize: number): number {
  // One point of slack keeps rounding from pushing the last cell off the line.
  return Math.max(10, Math.floor((width - SIDE_PADDING * 2 - 1) / (fontSize * MONO_ADVANCE_EM)));
}

type Props = {
  session: TerminalSession;
  state: TerminalState;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  /** Shown while there is nothing to draw yet. */
  placeholder: string | null;
  /** Tap on terminal text: focus desktop input or hide the phone keyboard. */
  onTap: () => void;
  readOnly?: boolean;
  active?: boolean;
  /**
   * Phones: no tool row above the terminal (the screen's menu opens the tools
   * through `ref`), and history status floats over the text only while
   * browsing, so every other point goes to terminal lines.
   */
  compact?: boolean;
  ref?: Ref<TerminalViewHandle>;
};

export type TerminalViewHandle = { openTools: () => void };

/**
 * The terminal as an inverted list of fixed-height lines: index 0 is the
 * bottom line, so new output stays pinned to the bottom without scrolling.
 *
 * Scrolling up more than two lines freezes the view (`startBrowsing`) so live
 * output cannot move the text being read; nearing the top loads older pages
 * with `surface.history`. Back at the bottom the live screen resumes. Pinch
 * changes the font size.
 */
export function TerminalView({ session, state, fontSize, onFontSizeChange, placeholder, onTap, readOnly = false, active = true, compact = false, ref }: Props) {
  const [width, setWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const prefs = usePrefs();
  // The desktop shows the computer's grid as is by default; phones wrap.
  const desktop = desktopBridge() !== null;
  const terminalWrap = desktop ? prefs.desktopTerminalWrap : prefs.terminalWrap;
  const setTerminalWrap = (wrap: boolean) => setPrefs(desktop ? { desktopTerminalWrap: wrap } : { terminalWrap: wrap });
  const wasLiveBeforeTools = useRef(false);
  const [cache] = useState(() => new LayoutCache());
  const [pinchSize, setPinchSize] = useState<number | null>(null);
  const pinchBase = useRef(fontSize);
  const list = useRef<FlatList<PositionedLine>>(null);
  const horizontal = useRef<ScrollViewInstance>(null);
  const horizontalOffset = useRef(0);
  const restored = useRef<typeof state.restoredReading>(null);
  const lastFromBottom = useRef(0);
  const laidOut = useRef('');
  const viewPosition = useRef<ReadingPosition | null>(null);
  const shortHistory = useRef(false);
  const requestedOffset = useRef<number | null>(null);
  const dragging = useRef(false);
  const wheeling = useRef(false);
  const wheelCarry = useRef(0);
  const scrollRange = useRef(0);
  const historyRunway = useRef(0);
  const lastScrollSample = useRef({ at: 0, offset: 0 });
  // Unwrapped on the desktop, a terminal wider than the window shrinks its
  // font (down to a readable floor) instead of hiding its right edge.
  const fitColumns = desktop && !terminalWrap ? state.terminalColumns ?? 0 : 0;
  const size = pinchSize ?? (fitColumns > 0 && width > 0 ? fitFontSize(width, fitColumns, fontSize) : fontSize);
  const lineHeight = Math.round(size * 1.3);
  const columns = width > 0 ? terminalColumns(width, size) : 0;
  const browse = state.browse;
  const wasBrowsing = useRef(Boolean(browse));
  const seenInputRevision = useRef(state.inputRevision ?? 0);
  const applicationScroll = state.applicationScroll;
  const applicationEnabled = Boolean(applicationScroll);
  useEffect(() => () => session.stopApplicationScroll(), [session]);
  useEffect(() => {
    if (active && state.subscription === 'live') void session.inspectScrollMode().then(() => session.prepareHistory());
  }, [session, state.subscription, active]);
  useEffect(() => {
    if (active && state.subscription === 'live') session.prepareHistory();
  }, [session, state.subscription, state.screen.rows, applicationEnabled, browse, active]);
  const rows = browse ? browse.frozenRows : state.screen.rows;
  const olderRows = browse?.olderRows;
  const allRows = useMemo(() => [...(olderRows ?? []), ...rows], [olderRows, rows]);
  const rawColumns = useMemo(() => terminalWrap ? 0 : allRows.reduce((max, row) => Math.max(max, terminalRowColumns(row)), 1), [allRows, terminalWrap]);
  const contentWidth = terminalWrap ? width : Math.max(width, rawColumns * size * MONO_ADVANCE_EM + SIDE_PADDING * 2 + 2);
  const layoutKey = `${terminalWrap}:${columns}:${size}:${viewportHeight}`;

  const lines = useMemo(() => {
    if (columns === 0) return [];
    return positionedLines(allRows, columns, cache, terminalWrap);
  }, [allRows, columns, cache, terminalWrap]);
  const cursor = liveCursor(state, rows, (row) => cache.get(row, columns, terminalWrap).length === 1);

  const restoreOffset = useCallback(() => {
    if (!list.current || viewportHeight <= 0 || !lines.length) return;
    const changedLayout = laidOut.current !== layoutKey;
    const position = (changedLayout ? viewPosition.current : null) ?? state.restoredReading;
    laidOut.current = layoutKey;
    if (dragging.current) {
      restored.current = state.restoredReading;
      return;
    }
    if (!position || (!changedLayout && restored.current === position)) return;
    const index = restoredLineIndex(lines, position);
    if (index < 0) return;
    restored.current = state.restoredReading;
    const offset = Math.min(index * lineHeight, Math.max(0, lines.length * lineHeight - viewportHeight));
    lastFromBottom.current = offset;
    requestedOffset.current = offset;
    list.current?.scrollToOffset({ offset, animated: false });
    if (!terminalWrap) horizontal.current?.scrollTo({ x: position.horizontalColumns * size * MONO_ADVANCE_EM, animated: false });
  }, [state.restoredReading, lines, lineHeight, size, terminalWrap, viewportHeight, layoutKey]);
  useEffect(() => {
    if (!state.restoredReading) restored.current = null;
    restoreOffset();
  }, [state.restoredReading, restoreOffset]);
  useEffect(() => {
    const inputChanged = seenInputRevision.current !== (state.inputRevision ?? 0);
    if (inputChanged || (wasBrowsing.current && !browse)) {
      // Input can end history browsing outside this view. Clear its old offset
      // as well, or a stale native scroll event immediately freezes it again.
      shortHistory.current = false;
      viewPosition.current = null;
      lastFromBottom.current = 0;
      requestedOffset.current = 0;
      list.current?.scrollToOffset({ offset: 0, animated: false });
    }
    wasBrowsing.current = Boolean(browse);
    seenInputRevision.current = state.inputRevision ?? 0;
  }, [browse, state.inputRevision]);

  const savePosition = () => {
    const current = session.getState();
    if (!current.browse || current.browse.kind === 'application' || current.restoringReading || !lines.length) return;
    const index = Math.max(0, Math.min(lines.length - 1, Math.round(lastFromBottom.current / lineHeight)));
    const position = makeReadingPosition(allRows, lines[index], horizontalOffset.current / (size * MONO_ADVANCE_EM));
    viewPosition.current = position;
    session.rememberReading(position);
  };

  const lineStyle = useMemo<TextStyle>(
    () => ({
      fontFamily: fonts.mono,
      fontSize: size,
      lineHeight,
      height: lineHeight,
      color: DEFAULT_FG,
      includeFontPadding: false,
    }),
    [size, lineHeight],
  );

  const nativeScroll = useNativeGesture({});
  const pinch = usePinchGesture({
    runOnJS: true,
    simultaneousWith: nativeScroll,
    onActivate: () => {
      session.stopApplicationScroll();
      pinchBase.current = fontSize;
    },
    onUpdate: (event) => {
      const next = clampFontSize(pinchBase.current * event.scale);
      setPinchSize((current) => (current === next ? current : next));
    },
    onDeactivate: (event) => {
      onFontSizeChange(clampFontSize(pinchBase.current * event.scale));
      setPinchSize(null);
    },
  });

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  const beginDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragging.current = true;
    requestedOffset.current = null;
    if (toolsOpen || state.restoringReading) return;
    void session.inspectScrollMode();
    const program = session.getState().applicationScroll;
    if (program) {
      // Reading the record changes nothing on the computer, so read-only viewers can too.
      if (program.record !== false) { session.startApplicationHistory(); retryApplicationHistory(); ensureHistoryRunway(); }
      return;
    }
    if (!session.getState().browse) {
      shortHistory.current = true;
      session.startBrowsing();
    }
    ensureHistoryRunway();
    const { contentSize, layoutMeasurement } = event.nativeEvent;
    // A short visible screen has no scroll range yet. Pulling it must still
    // request scrollback instead of requiring an offset the list cannot reach.
    if (contentSize.height <= layoutMeasurement.height + lineHeight) {
      shortHistory.current = true;
      session.startBrowsing();
      void session.loadOlder();
    }
  };

  // "请再次滑动重试": a new gesture retries a failed program-history step.
  const retryApplicationHistory = () => {
    const current = session.getState().browse;
    if (current?.kind === 'application' && current.error && !current.loading) void session.loadOlder({ retry: true });
  };

  const ensureHistoryRunway = useCallback(() => {
    const current = session.getState();
    if (toolsOpen || !active || current.restoringReading || !current.browse
      || (current.applicationScroll && current.browse.kind !== 'application')) return;
    const range = Math.max(scrollRange.current, lines.length * lineHeight - viewportHeight);
    const distance = range - Math.max(0, lastFromBottom.current);
    if (distance < Math.max(viewportHeight * 6, historyRunway.current)) void session.loadOlder();
  }, [session, toolsOpen, active, viewportHeight, lines.length, lineHeight]);
  useEffect(ensureHistoryRunway, [ensureHistoryRunway, rows, olderRows]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollRange.current = Math.max(0, event.nativeEvent.contentSize.height - event.nativeEvent.layoutMeasurement.height);
    if (session.getState().applicationScroll && session.getState().browse?.kind !== 'application' && !toolsOpen) {
      lastFromBottom.current = event.nativeEvent.contentOffset.y;
      return;
    }
    if (toolsOpen || state.restoringReading || laidOut.current !== layoutKey) return;
    if (state.restoredReading && restored.current !== state.restoredReading) return;
    const { contentOffset } = event.nativeEvent;
    const fromBottom = contentOffset.y;
    const now = Date.now(), sample = lastScrollSample.current;
    if (sample.at && now > sample.at && fromBottom > sample.offset) {
      const speed = (fromBottom - sample.offset) / (now - sample.at);
      historyRunway.current = Math.min(viewportHeight * 24, speed * 1800);
    }
    lastScrollSample.current = { at: now, offset: fromBottom };
    if (requestedOffset.current !== null) {
      // Native layout can emit a temporary zero before applying scrollToOffset.
      // That is not a user's return to the live edge.
      if (Math.abs(fromBottom - requestedOffset.current) > lineHeight) return;
      requestedOffset.current = null;
    }
    lastFromBottom.current = fromBottom;
    if (fromBottom > 2) {
      shortHistory.current = false;
      const line = lines[Math.max(0, Math.min(lines.length - 1, Math.round(fromBottom / lineHeight)))];
      if (line) viewPosition.current = makeReadingPosition(allRows, line, horizontalOffset.current / (size * MONO_ADVANCE_EM));
    }
    if (!browse && fromBottom > lineHeight * 2) {
      session.startBrowsing();
      const line = lines[Math.max(0, Math.min(lines.length - 1, Math.round(fromBottom / lineHeight)))];
      if (line) session.rememberReading(makeReadingPosition(allRows, line));
      ensureHistoryRunway();
      return;
    }
    if (browse && fromBottom <= 2) {
      // Replacing/retrying a snapshot can reset the native offset to zero.
      // Only a user drag/momentum is an instruction to leave history mode.
      if (shortHistory.current || !dragging.current) return;
      viewPosition.current = null;
      session.resumeLive();
      return;
    }
    if (browse) ensureHistoryRunway();
  };

  const jumpToLive = () => {
    shortHistory.current = false;
    requestedOffset.current = null;
    viewPosition.current = null;
    list.current?.scrollToOffset({ offset: 0, animated: false });
    session.resumeLive();
  };

  /** A program without a session record scrolls itself, as in any terminal. */
  const moveApplication = (lines: number) => session.scrollApplication(lines);
  const passWheel = (pixels: number) => {
    // About one wheel unit (three of the program's rows) per three rows of wheel travel.
    wheelCarry.current += pixels / (lineHeight * 3);
    const units = Math.trunc(wheelCarry.current);
    if (!units) return;
    wheelCarry.current -= units;
    moveApplication(units);
  };

  const reachedHistoryEdge = () => {
    const current = session.getState();
    if (toolsOpen || current.restoringReading || !current.browse) return;
    void session.loadOlder();
  };

  useTerminalCopy(list, active);
  useTerminalWheel(list, {
    enabled: active && !toolsOpen && !state.restoringReading,
    lineHeight, pageHeight: viewportHeight,
    move: pixels => {
      const current = session.getState();
      if (current.applicationScroll?.record === false) { if (!readOnly) passWheel(pixels); return; }
      dragging.current = true;
      requestedOffset.current = null;
      if (!wheeling.current) {
        wheeling.current = true;
        if (pixels > 0) retryApplicationHistory();
      }
      if (pixels > 0 && !current.browse) {
        shortHistory.current = true;
        if (current.applicationScroll) session.startApplicationHistory();
        else session.startBrowsing();
      }
      // Wheel events also arrive when the screen is too short to scroll.
      // Explicitly enter history so loading does not depend on a scroll event.
      if (pixels > 0) ensureHistoryRunway();
      const range = Math.max(scrollRange.current, lines.length * lineHeight - viewportHeight, 0);
      const offset = Math.max(0, Math.min(range, lastFromBottom.current + pixels));
      lastFromBottom.current = offset;
      if (offset > 2) shortHistory.current = false;
      list.current?.scrollToOffset({ offset, animated: false });
      if (pixels < 0 && offset <= 2 && session.getState().browse) jumpToLive();
    },
    end: () => { savePosition(); dragging.current = false; wheeling.current = false; },
  });

  const openTools = () => {
    wasLiveBeforeTools.current = !session.getState().browse;
    session.startBrowsing({ freezeApplication: true });
    setToolsOpen(true);
  };
  useImperativeHandle(ref, () => ({ openTools }));

  // Desktop: rows above the terminal, the history row always there so the
  // terminal does not resize when browsing starts. Phone: one floating stack
  // at the bottom left, shown only while there is something to say.
  const historyStatus = !compact || browse;
  const statusText = compact ? styles.floatingStatusText : styles.historyStatusText;
  const status = <>
    {state.restoringReading || state.readingNotice ? <Text style={[styles.readingNotice, compact && styles.floatingNotice]}>{state.restoringReading ? '正在恢复上次阅读的位置…' : state.readingNotice}</Text> : null}
    {applicationScroll?.record === false && historyStatus ? <View testID="terminal-application-scroll" style={[styles.historyStatus, compact && styles.floatingStatus]}>
      <Text style={statusText}>{readOnly ? '这个程序的滚动需要终端控制权限' : '滚轮直接滚动程序（没有可读取的会话记录）'}</Text>
      {!readOnly ? <>
        <Pressable testID="terminal-application-older" style={styles.historyLoad} onPress={() => moveApplication(3)} accessibilityRole="button" accessibilityLabel="查看程序内更早的历史"><Text style={styles.historyLoadText}>↑</Text></Pressable>
        <Pressable testID="terminal-application-newer" style={styles.historyLoad} onPress={() => moveApplication(-3)} accessibilityRole="button" accessibilityLabel="查看程序内更近的历史"><Text style={styles.historyLoadText}>↓</Text></Pressable>
      </> : null}
    </View> : null}
    {applicationScroll?.error ? <Text style={[styles.historyRetry, styles.edgeError, compact && styles.floatingNotice]}>{applicationScroll.error} · 请再次滑动重试</Text> : null}
    {applicationScroll?.record !== false && historyStatus ? <View testID={browse ? 'terminal-history-status' : undefined} style={[styles.historyStatus, compact ? styles.floatingStatus : styles.stableHistoryStatus]}>
      <Text style={statusText}>
        {!browse ? (applicationScroll ? '向上滑动查看会话记录' : '向上滑动查看历史')
          : browse.kind === 'application' ? `已读取会话记录 ${browse.olderRows.length} 行${browse.exhausted ? ' · 已到会话开头' : ''}`
          : browse.exhausted && browse.olderRows.length === 0
          ? `电脑只返回当前 ${browse.frozenRows.length} 行，未提供更早历史`
          : `已加载 ${browse.olderRows.length} 行历史${browse.exhausted ? ' · 已到本次起点' : ''}`}
      </Text>
      {browse && !browse.exhausted ? <Pressable testID="terminal-history-load" disabled={browse.loading || state.restoringReading}
        style={styles.historyLoad} onPress={() => void session.loadOlder({ retry: Boolean(browse.error) })} accessibilityRole="button">
        <Text style={styles.historyLoadText}>{browse.restartRequired ? '重新加载' : '加载更早'}</Text>
      </Pressable> : null}
    </View> : null}
    {browse?.error ? <Pressable testID="terminal-history-retry" style={[styles.historyRetry, compact && styles.floatingNotice]} onPress={() => void session.loadOlder({ retry: true })} accessibilityRole="button">
      <Text style={styles.edgeError}>{browse.error} · {browse.restartRequired ? '重新加载历史' : '重试'}</Text>
    </Pressable> : null}
  </>;

  const terminalList = (
    <GestureDetector gesture={nativeScroll}>
    <FlatList
      ref={list}
      testID="terminal-output-list"
      style={styles.fill}
      inverted
      data={lines}
      keyExtractor={keyForIndex}
      renderItem={({ item }) => <TerminalLine line={item} style={lineStyle} size={size} onPress={onTap}
        cursor={cursor && item.rowFromBottom === cursor.rowFromBottom && item.segmentFromBottom === 0 ? cursor.column : undefined} />}
      extraData={cursor ? `${cursor.rowFromBottom}:${cursor.column}` : ''}
      getItemLayout={(_, index) => ({ length: lineHeight, offset: lineHeight * index, index })}
      initialNumToRender={60}
      maxToRenderPerBatch={60}
      windowSize={9}
      onScroll={onScroll}
      onEndReached={reachedHistoryEdge}
      onEndReachedThreshold={6}
      onScrollBeginDrag={beginDrag}
      onContentSizeChange={(_, height) => { scrollRange.current = Math.max(0, height - viewportHeight); restoreOffset(); ensureHistoryRunway(); }}
      onLayout={restoreOffset}
      onScrollEndDrag={() => { savePosition(); dragging.current = false; }}
      onMomentumScrollBegin={() => { dragging.current = true; }}
      onMomentumScrollEnd={() => { savePosition(); dragging.current = false; }}
      nestedScrollEnabled
      scrollEventThrottle={32}
      alwaysBounceVertical
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      removeClippedSubviews={Platform.OS === 'android'}
      contentContainerStyle={styles.content}
      ListFooterComponent={browse ? <HistoryEdge state={state} session={session} /> : undefined}
    />
    </GestureDetector>
  );

  return (
    <View testID="terminal-output" style={styles.container} onLayout={onLayout}>
      {!compact ? <View style={styles.toolRow}>
        <Pressable style={styles.tools} onPress={() => setTerminalWrap(!terminalWrap)} accessibilityRole="button" accessibilityLabel={terminalWrap ? '切换为原始列宽' : '切换为自动折行'}><Text style={styles.toolsText}>{terminalWrap ? '自动折行' : '原始列宽 ↔'}</Text></Pressable>
        <Pressable style={styles.tools} onPress={openTools} accessibilityRole="button" accessibilityLabel="搜索和复制终端输出">
          <Text style={styles.toolsText}>搜索 · 复制输出</Text>
        </Pressable>
      </View> : null}
      {!compact ? status : null}
      <GestureDetector gesture={pinch}>
        <View testID="terminal-viewport" style={styles.fill} onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}>
          {terminalWrap ? terminalList : (
            <ScrollView ref={horizontal} testID="terminal-horizontal-scroll" horizontal directionalLockEnabled nestedScrollEnabled alwaysBounceVertical={false} style={styles.fill}
              contentContainerStyle={{ width: contentWidth, height: viewportHeight }}
              onScroll={(event) => { horizontalOffset.current = event.nativeEvent.contentOffset.x; }} onScrollEndDrag={savePosition} scrollEventThrottle={32}>
              <View testID="terminal-raw-frame" style={{ width: contentWidth, height: viewportHeight }}>{terminalList}</View>
            </ScrollView>
          )}
        </View>
      </GestureDetector>
      {lines.length === 0 && placeholder ? (
        <View style={styles.placeholder} pointerEvents="none">
          <Text style={styles.placeholderText}>{placeholder}</Text>
        </View>
      ) : null}
      {compact ? <View testID="terminal-floating-status" style={styles.floating} pointerEvents="box-none">{status}</View> : null}
      {pinchSize !== null ? (
        <View style={styles.sizeBadge} pointerEvents="none">
          <Text style={styles.sizeBadgeText}>
            {pinchSize} pt · {columns} 列
          </Text>
        </View>
      ) : null}
      {browse ? (
        <Pressable style={styles.jump} onPress={jumpToLive} accessibilityRole="button" accessibilityLabel="回到最新输出">
          <Text style={styles.jumpText}>{browse.liveChanged ? '有新输出' : '回到底部'} ↓</Text>
        </Pressable>
      ) : null}
      {toolsOpen ? <TerminalTools visible onClose={() => { setToolsOpen(false); if (wasLiveBeforeTools.current) session.resumeLive(); }} state={state} session={session} /> : null}
    </View>
  );
}

function keyForIndex(_: VisualLine, index: number): string {
  return String(index);
}

type LineProps = { line: VisualLine; style: TextStyle; size: number; onPress: () => void; cursor?: number };

const TerminalLine = memo(function TerminalLine({ line, style, size, onPress, cursor }: LineProps) {
  const text = { style, onPress, selectable: Platform.OS === 'web', allowFontScaling: false, ...TERMINAL_LINE_DATA };
  if (cursor !== undefined) {
    const { before, at, after } = splitAtCursor(line.spans, cursor);
    return (
      <Text {...text} numberOfLines={1} ellipsizeMode="clip">
        {before.map((span, index) => <SpanText key={`b${index}`} span={span} size={size} />)}
        <SpanText span={at} size={size} cursor />
        {after.map((span, index) => <SpanText key={`a${index}`} span={span} size={size} />)}
      </Text>
    );
  }
  if (line.spans.length === 0) return <Text {...text}> </Text>;
  if (line.spans.length === 1 && line.spans[0].attr === DEFAULT_ATTR && Platform.OS !== 'web') {
    return <Text {...text} numberOfLines={1} ellipsizeMode="clip">{line.spans[0].text}</Text>;
  }
  return (
    <Text {...text} numberOfLines={1} ellipsizeMode="clip">
      {line.spans.map((span, index) => <SpanText key={index} span={span} size={size} />)}
    </Text>
  );
});

const CURSOR_STYLE: TextStyle = { backgroundColor: colors.ink, color: colors.terminal };

/** One styled run; on the web every non-GeistMono glyph gets a box of its terminal width. */
function SpanText({ span, size, cursor = false }: { span: Span; size: number; cursor?: boolean }) {
  const attr = span.attr === DEFAULT_ATTR ? null : styleForAttr(span.attr);
  const style = cursor ? [attr, CURSOR_STYLE] : attr;
  if (Platform.OS !== 'web') return <Text style={style}>{span.text}</Text>;
  const runs = cellRuns(span.text);
  if (runs.length === 1 && runs[0].kind === 'text') return <Text style={style}>{span.text}</Text>;
  const cell = size * MONO_ADVANCE_EM;
  return (
    <Text style={style}>
      {runs.map((run, index) => run.kind === 'text' ? run.text : (
        <Text key={index} style={(run.kind === 'wide'
          // CJK glyphs advance 1 em; spacing makes each exactly two cells.
          ? { display: 'inline-block', width: run.cells * cell, letterSpacing: 2 * cell - size }
          : { display: 'inline-block', width: run.cells * cell, textAlign: 'center' }) as unknown as TextStyle}>{run.text}</Text>
      ))}
    </Text>
  );
}

/**
 * The computer's cursor on the live screen: the line it is on and its cell.
 * Hidden while reading history, past the last row (the relay's "hidden"), on
 * a row that wraps into several lines, and for the (0, 0) placeholder older
 * relays send.
 */
export function liveCursor(state: TerminalState, rows: readonly string[], singleLine: (row: string) => boolean): { rowFromBottom: number; column: number } | null {
  const { x, y } = state.screen.cursor;
  if (state.browse || state.subscription !== 'live' || !Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= rows.length || x < 0) return null;
  if (x === 0 && y === 0 && rows.length > 1) return null;
  if (!singleLine(rows[y])) return null;
  return { rowFromBottom: rows.length - 1 - y, column: x };
}

/** Splits a line at terminal cell `column`, padding with spaces when the cursor sits past the text. */
export function splitAtCursor(spans: readonly Span[], column: number): { before: Span[]; at: Span; after: Span[] } {
  const before: Span[] = [], after: Span[] = [];
  let at: Span | null = null;
  let used = 0;
  for (const span of spans) {
    if (at) { after.push(span); continue; }
    const chars = Array.from(span.text);
    let index = 0, prefix = '';
    for (; index < chars.length; index++) {
      const width = codePointWidth(chars[index].codePointAt(0)!);
      if (width > 0 && used + width > column) break;
      prefix += chars[index]; used += width;
    }
    if (index === chars.length) { before.push(span); continue; }
    if (prefix) before.push({ text: prefix, attr: span.attr });
    let next = index + 1, covered = chars[index];
    while (next < chars.length && codePointWidth(chars[next].codePointAt(0)!) === 0) covered += chars[next++];
    at = { text: covered, attr: span.attr };
    const rest = chars.slice(next).join('');
    if (rest) after.push({ text: rest, attr: span.attr });
  }
  if (!at) {
    if (column > used) before.push({ text: ' '.repeat(column - used), attr: DEFAULT_ATTR });
    at = { text: ' ', attr: DEFAULT_ATTR };
  }
  return { before, at, after };
}

/** The largest size, at most the chosen one, that fits `columns` cells in `width`. */
export function fitFontSize(width: number, columns: number, preferred: number): number {
  const fits = (width - SIDE_PADDING * 2 - 1) / (columns * MONO_ADVANCE_EM);
  return Math.max(MIN_FIT_FONT, Math.min(preferred, Math.floor(fits * 2) / 2));
}
const MIN_FIT_FONT = 9;

/** Shown above the oldest loaded line while browsing history. */
function HistoryEdge({ state, session }: { state: TerminalState; session: TerminalSession }) {
  const browse = state.browse;
  if (!browse) return null;
  let content;
  if (browse.loading) {
    content = <Text style={styles.edgeText}>正在加载更早的输出…</Text>;
  } else if (browse.error) {
    content = (
      <Pressable onPress={() => void session.loadOlder({ retry: true })} accessibilityRole="button">
        <Text style={[styles.edgeText, styles.edgeError]}>{browse.error}（{browse.restartRequired ? '点按重新加载' : '点按重试'}）</Text>
      </Pressable>
    );
  } else if (browse.exhausted) {
    content = <Text style={styles.edgeText}>— 已到本次可读取的最早输出 —</Text>;
  } else {
    content = <Pressable onPress={() => void session.loadOlder()} accessibilityRole="button"><Text style={styles.edgeText}>继续上滑或点按加载更早的输出</Text></Pressable>;
  }
  return <View style={styles.edge}>{content}</View>;
}

const styles = StyleSheet.create({
  toolRow: { flexDirection: 'row', justifyContent: 'space-between' },
  readingNotice: { color: colors.muted, fontSize: 12, paddingHorizontal: 12, paddingBottom: 5 },
  historyRetry: { paddingHorizontal: 12, paddingVertical: 6 },
  historyStatus: { paddingHorizontal: 12, paddingBottom: 5, flexDirection: 'row', alignItems: 'center', gap: 8 },
  stableHistoryStatus: { height: 37 },
  historyStatusText: { flex: 1, color: colors.muted, fontSize: 12, lineHeight: 17 },
  // Bottom left, beside "回到底部": the top of the list holds the history edge's own message.
  floating: { position: 'absolute', bottom: 8, left: 8, right: 128, alignItems: 'flex-start', gap: 4 },
  floatingStatus: {
    maxWidth: '100%',
    paddingLeft: 10,
    paddingRight: 4,
    paddingTop: 4,
    paddingBottom: 4,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  floatingStatusText: { flexShrink: 1, color: colors.muted, fontSize: 12, lineHeight: 17 },
  floatingNotice: { maxWidth: '100%', paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 8, backgroundColor: colors.surface, overflow: 'hidden' },
  historyLoad: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6, backgroundColor: colors.surfaceRaised },
  historyLoadText: { color: colors.blue, fontSize: 12 },
  tools: { alignSelf: 'flex-end', paddingHorizontal: 12, paddingVertical: 5 },
  toolsText: { color: colors.muted, fontSize: 12 },
  container: { flex: 1, backgroundColor: colors.canvas },
  fill: { flex: 1, minHeight: 0 },
  content: { paddingHorizontal: SIDE_PADDING, paddingTop: 4 },
  edge: { paddingVertical: 12, alignItems: 'center' },
  edgeText: { color: colors.muted, fontSize: 12 },
  edgeError: { color: colors.red },
  placeholder: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: colors.muted, fontSize: 14 },
  sizeBadge: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: colors.surfaceRaised,
  },
  sizeBadgeText: { color: colors.ink, fontSize: 12 },
  jump: {
    position: 'absolute',
    bottom: 10,
    right: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  jumpText: { color: colors.ink, fontSize: 13 },
});
