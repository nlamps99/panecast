import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
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
import { GestureDetector, useNativeGesture, usePanGesture, usePinchGesture, useSimultaneousGestures } from 'react-native-gesture-handler';

import type { TerminalSession, TerminalState } from '../session/terminalSession';
import { DEFAULT_ATTR } from '../terminal/ansi';
import { LayoutCache, type Span, type VisualLine } from '../terminal/layout';
import { cellRuns } from '../terminal/cellRuns';
import { codePointWidth } from '../terminal/cellWidth';
import { desktopBridge } from '../platform/desktop';
import { TERMINAL_LINE_DATA, useTerminalCopy } from '../input/terminalCopy';
import { TERMINAL_CURSOR_DATA } from '../input/terminalFocus';
import { makeReadingPosition, PositionedLineCache, positionedLineKey, restoredLineIndex, type PositionedLine, type ReadingPosition } from '../session/readingPosition';
import { DEFAULT_FG, styleForAttr } from '../terminal/palette';
import { clampFontSize, setPrefs, usePrefs } from '../state/prefs';
import { colors, fonts, MONO_ADVANCE_EM } from './theme';
import { TerminalTools } from './TerminalTools';
import { TerminalFindBar } from './TerminalFindBar';
import { desktopFontSize, showDesktopFontSize } from './terminalZoom';
import { useTerminalWheel } from '../input/terminalWheel';
import { PROGRAM_ROWS_PER_UNIT, PROGRAM_TOUCH_MAX_QUEUED, programDragTravel, programFlingTravel, programScrollUnits } from '../terminal/programScroll';
import { findNeedle, findRanges, firstLineOfRow, markSpans } from '../terminal/find';
import { matchingRows, plainTerminalRows } from '../terminal/textTools';
import { screenRepainted } from '../terminal/screenSwitch';

const SIDE_PADDING = 8;

/**
 * The terminal pane's last measured size. Switching terminals mounts a new
 * view; starting from this size draws its first frame at the right width
 * instead of the placeholder.
 */
const lastViewport = { width: 0, height: 0 };

/**
 * Each terminal's last reported column count. A new view fits the desktop
 * text to it from the first frame, before `terminal.replay` answers, instead
 * of drawing at full size and then shrinking.
 */
const knownColumns = new Map<string, number>();
const KNOWN_COLUMNS_MAX = 64;

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
  /** A button under the placeholder, such as "重试" after the terminal could not be opened. */
  placeholderAction?: { label: string; onPress: () => void } | null;
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
  /**
   * Desktop window: the screen's header holds the wrap and search buttons,
   * so there is no tool row, and history status floats as on phones.
   */
  toolsInHeader?: boolean;
  /** The find bar closed: the screen puts focus back in the terminal input. */
  onFindClosed?: () => void;
  ref?: Ref<TerminalViewHandle>;
};

export type TerminalViewHandle = {
  /** Search: the find bar over the terminal on the desktop (⌘F), the search and copy sheet on phones. */
  openTools: () => void;
  /** The search and copy sheet, on every platform: paging through the loaded output and copying it. */
  openOutput: () => void;
};

/**
 * The terminal as an inverted list of fixed-height lines: index 0 is the
 * bottom line, so new output stays pinned to the bottom without scrolling.
 *
 * Scrolling up more than two lines freezes the view (`startBrowsing`) so live
 * output cannot move the text being read; nearing the top loads older pages
 * with `surface.history`. Back at the bottom the live screen resumes. Pinch
 * changes the font size.
 */
export function TerminalView({ session, state, fontSize, onFontSizeChange, placeholder, placeholderAction = null, onTap, readOnly = false, active = true, compact = false, toolsInHeader = false, onFindClosed, ref }: Props) {
  const [width, setWidth] = useState(() => lastViewport.width);
  const [viewportHeight, setViewportHeight] = useState(() => lastViewport.height);
  const [toolsOpen, setToolsOpen] = useState(false);
  const prefs = usePrefs();
  // The desktop shows the computer's grid as is by default; phones wrap.
  const desktop = desktopBridge() !== null;
  const terminalWrap = desktop ? prefs.desktopTerminalWrap : prefs.terminalWrap;
  const setTerminalWrap = (wrap: boolean) => setPrefs(desktop ? { desktopTerminalWrap: wrap } : { terminalWrap: wrap });
  const wasLiveBeforeTools = useRef(false);
  const [cache] = useState(() => new LayoutCache());
  const [positioned] = useState(() => new PositionedLineCache());
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
  const expanders = useRef(new Map<string, () => void>());
  const wheelCarry = useRef(0);
  const touchCarry = useRef(0);
  const [programNotice, setProgramNotice] = useState<string | null>(null);
  const programNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRange = useRef(0);
  const historyRunway = useRef(0);
  const lastScrollSample = useRef({ at: 0, offset: 0 });
  const savedPosition = useRef<ReadingPosition | null>(null);
  // The web has no drag-end or momentum events: a pause in scroll events ends the gesture.
  const scrollEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleRef = useRef<() => void>(() => {});
  // One tap handler for every line, so a new `onTap` from the screen does not redraw them all.
  const tapRef = useRef(onTap);
  useLayoutEffect(() => { tapRef.current = onTap; });
  const tap = useCallback(() => tapRef.current(), []);
  // The desktop's find bar (⌘F); phones keep the search and copy sheet.
  const inlineFind = !compact && Platform.OS === 'web';
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  /** Steps from the newest match toward older ones. */
  const [findStep, setFindStep] = useState(0);
  const [findFocus, setFindFocus] = useState(0);
  const wasLiveBeforeFind = useRef(false);
  const revealedMatch = useRef('');
  // Desktop: unwrapped, the computer's columns fit the window (at most the
  // chosen size) unless ⌘= / ⌘- fixed a size, which then scrolls sideways or wraps.
  const columnsKey = state.target ? `${state.target.workspaceId}\u0000${state.target.surfaceId}` : '';
  const gridColumns = state.terminalColumns ?? knownColumns.get(columnsKey) ?? null;
  useEffect(() => {
    if (!columnsKey || !state.terminalColumns) return;
    knownColumns.delete(columnsKey);
    knownColumns.set(columnsKey, state.terminalColumns);
    while (knownColumns.size > KNOWN_COLUMNS_MAX) knownColumns.delete(knownColumns.keys().next().value!);
  }, [columnsKey, state.terminalColumns]);
  const size = pinchSize ?? (desktop
    ? desktopFontSize({ preference: fontSize, zoom: prefs.desktopFontZoom ?? null, wrap: terminalWrap, width, columns: gridColumns })
    : fontSize);
  // ⌘= / ⌘- and settings' A− / A+ step from what is on screen.
  useEffect(() => {
    if (desktop) showDesktopFontSize(size);
  }, [desktop, size]);
  const lineHeight = Math.round(size * 1.3);
  const columns = width > 0 ? terminalColumns(width, size) : 0;
  const browse = state.browse;
  const wasBrowsing = useRef(Boolean(browse));
  const seenInputRevision = useRef(state.inputRevision ?? 0);
  const applicationScroll = state.applicationScroll;
  const applicationEnabled = Boolean(applicationScroll);
  useEffect(() => () => session.stopApplicationScroll(), [session]);
  useEffect(() => () => { if (programNoticeTimer.current) clearTimeout(programNoticeTimer.current); }, []);
  useEffect(() => {
    if (active && state.subscription === 'live') void session.inspectScrollMode().then(() => session.prepareHistory());
  }, [session, state.subscription, active]);
  useEffect(() => {
    if (active && state.subscription === 'live') session.prepareHistory();
  }, [session, state.subscription, state.screen.rows, applicationEnabled, browse, active]);
  // Starting or quitting a full-screen program (claude, vim) repaints the whole
  // screen and changes how scrolling works: ask the computer again.
  const watchedScreen = useRef<readonly string[] | null>(null);
  const repaintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRepaintCheck = useRef(0);
  const screenRows = state.screen.rows;
  const liveScreen = active && state.subscription === 'live' && !state.fromCache;
  useEffect(() => {
    const previous = watchedScreen.current;
    watchedScreen.current = liveScreen ? screenRows : null;
    if (!liveScreen || !previous || repaintTimer.current || !screenRepainted(previous, screenRows)) return;
    const wait = Math.max(REPAINT_SETTLE_MS, lastRepaintCheck.current + REPAINT_INTERVAL_MS - Date.now());
    repaintTimer.current = setTimeout(() => {
      repaintTimer.current = null;
      lastRepaintCheck.current = Date.now();
      void session.inspectScrollMode();
    }, wait);
  }, [session, screenRows, liveScreen]);
  useEffect(() => () => {
    if (repaintTimer.current) clearTimeout(repaintTimer.current);
    if (scrollEndTimer.current) clearTimeout(scrollEndTimer.current);
  }, []);
  const rows = browse ? browse.frozenRows : state.screen.rows;
  const olderRows = browse?.olderRows;
  const allRows = useMemo(() => [...(olderRows ?? []), ...rows], [olderRows, rows]);
  const rawColumns = useMemo(() => terminalWrap ? 0 : allRows.reduce((max, row) => Math.max(max, cache.rowColumns(row)), 1), [allRows, terminalWrap, cache]);
  const contentWidth = terminalWrap ? width : Math.max(width, rawColumns * size * MONO_ADVANCE_EM + SIDE_PADDING * 2 + 2);
  const layoutKey = `${terminalWrap}:${columns}:${size}:${viewportHeight}`;

  const cursor = columns > 0 ? liveCursor(state, rows, (row) => cache.get(row, columns, terminalWrap).length === 1) : null;
  // A cursor on a blank last row keeps that row, which would otherwise be trimmed as padding.
  const keepRows = cursor ? allRows.length - cursor.rowFromBottom : 0;
  const lines = useMemo(() => {
    if (columns === 0) return [];
    return positioned.lines(allRows, columns, cache, terminalWrap, keepRows);
  }, [allRows, columns, cache, positioned, terminalWrap, keepRows]);

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
      savedPosition.current = null;
      lastFromBottom.current = 0;
      requestedOffset.current = 0;
      list.current?.scrollToOffset({ offset: 0, animated: false });
    }
    wasBrowsing.current = Boolean(browse);
    seenInputRevision.current = state.inputRevision ?? 0;
  }, [browse, state.inputRevision]);

  const savePosition = () => {
    const current = session.getState();
    if (!current.browse || current.restoringReading || !lines.length) return;
    const index = Math.max(0, Math.min(lines.length - 1, Math.round(lastFromBottom.current / lineHeight)));
    const position = makeReadingPosition(allRows, lines[index], horizontalOffset.current / (size * MONO_ADVANCE_EM));
    viewPosition.current = position;
    // Several end signals can describe one stop (wheel end, web scroll end).
    const saved = savedPosition.current;
    if (saved && saved.anchor === position.anchor && saved.rowFromBottom === position.rowFromBottom
      && saved.segmentFromBottom === position.segmentFromBottom && saved.horizontalColumns === position.horizontalColumns) return;
    savedPosition.current = position;
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
      ...(Platform.OS === 'web' ? WEB_LINE : null),
    }),
    [size, lineHeight],
  );

  const nativeScroll = useNativeGesture({});
  const pinch = usePinchGesture({
    runOnJS: true,
    simultaneousWith: nativeScroll,
    onActivate: () => {
      session.stopApplicationScroll();
      // The desktop pinches what it shows (a fitted size, or the zoom).
      pinchBase.current = desktop ? size : fontSize;
    },
    onUpdate: (event) => {
      const next = clampFontSize(pinchBase.current * event.scale);
      setPinchSize((current) => (current === next ? current : next));
    },
    onDeactivate: (event) => {
      const next = clampFontSize(pinchBase.current * event.scale);
      // The desktop terminal draws `desktopFontZoom` over the preference, so a pinch sets that.
      if (desktop) setPrefs({ desktopFontZoom: next });
      else onFontSizeChange(next);
      setPinchSize(null);
    },
  });

  // Phones: a full-screen program without a session record (htop, vim,
  // lazygit) scrolls itself, like a mouse wheel in any terminal. A wrapped
  // screen taller than the viewport scrolls locally first; only travel past
  // its edge goes to the program, one wheel unit per request.
  const programTouch = Platform.OS !== 'web' && !desktop && !readOnly && active && !toolsOpen && applicationScroll?.record === false;
  const sendProgramTravel = (pixels: number) => {
    const range = Math.max(scrollRange.current, lines.length * lineHeight - viewportHeight, 0);
    const travel = programDragTravel(pixels, lastFromBottom.current, range);
    if (!travel) return;
    const next = programScrollUnits(touchCarry.current, travel, lineHeight * PROGRAM_ROWS_PER_UNIT);
    touchCarry.current = next.carry;
    if (next.units) session.scrollApplication(next.units, { batch: 1, maxQueued: PROGRAM_TOUCH_MAX_QUEUED });
  };
  const programPan = usePanGesture({
    runOnJS: true,
    enabled: programTouch,
    maxPointers: 1,
    activeOffsetY: [-6, 6],
    failOffsetX: [-24, 24],
    simultaneousWith: nativeScroll,
    onActivate: () => {
      touchCarry.current = 0;
      // A new touch drops unsent momentum and clears a failed step ("请再次滑动重试").
      session.stopApplicationScroll(true);
    },
    // Finger down (positive) reveals older output, as the wheel does.
    onUpdate: (event) => sendProgramTravel(event.changeY),
    onDeactivate: (event) => { if (!event.canceled) sendProgramTravel(programFlingTravel(event.velocityY, viewportHeight)); },
  });
  const viewportGesture = useSimultaneousGestures(pinch, programPan);
  const flashProgramNotice = (text: string) => {
    setProgramNotice(text);
    if (programNoticeTimer.current) clearTimeout(programNoticeTimer.current);
    programNoticeTimer.current = setTimeout(() => setProgramNotice(null), 3000);
  };

  const onLayout = (event: LayoutChangeEvent) => {
    lastViewport.width = event.nativeEvent.layout.width;
    setWidth(event.nativeEvent.layout.width);
  };
  const onViewportLayout = (event: LayoutChangeEvent) => {
    lastViewport.height = event.nativeEvent.layout.height;
    setViewportHeight(event.nativeEvent.layout.height);
  };

  const beginDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragging.current = true;
    requestedOffset.current = null;
    if (toolsOpen || state.restoringReading) return;
    void session.inspectScrollMode();
    const program = session.getState().applicationScroll;
    if (program) {
      // Reading the record changes nothing on the computer, so read-only viewers can too.
      if (program.record !== false) { session.startApplicationHistory(); retryApplicationHistory(); ensureHistoryRunway(); }
      else if (readOnly && compact) flashProgramNotice('只读：不能滚动这个程序');
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

  /** The web's stand-in for drag-end and momentum-end events. */
  const scheduleScrollEnd = () => {
    if (Platform.OS !== 'web') return;
    if (scrollEndTimer.current) clearTimeout(scrollEndTimer.current);
    scrollEndTimer.current = setTimeout(() => {
      scrollEndTimer.current = null;
      // A wheel gesture ends on its own (`end` below).
      if (!wheeling.current) settleRef.current();
    }, WEB_SCROLL_END_MS);
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollRange.current = Math.max(0, event.nativeEvent.contentSize.height - event.nativeEvent.layoutMeasurement.height);
    scheduleScrollEnd();
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
    // At the bottom, history ends when the gesture does (`settle`): an
    // overshoot that turns back keeps the pages already loaded.
    if (browse && fromBottom > 2) ensureHistoryRunway();
  };

  const jumpToLive = () => {
    shortHistory.current = false;
    requestedOffset.current = null;
    viewPosition.current = null;
    savedPosition.current = null;
    lastFromBottom.current = 0;
    list.current?.scrollToOffset({ offset: 0, animated: false });
    session.resumeLive();
  };

  /**
   * A drag, fling or wheel gesture ended. Ending at the bottom returns to the
   * live screen; anywhere else the place is remembered. Replacing or
   * retrying a snapshot can reset the offset to zero without a gesture, which
   * is not an instruction to leave history.
   */
  const settle = () => {
    const gesture = dragging.current;
    dragging.current = false;
    const current = session.getState();
    if (gesture && current.browse && !shortHistory.current && !current.restoringReading && !toolsOpen && !findOpen && lastFromBottom.current <= 2) {
      jumpToLive();
      return;
    }
    savePosition();
  };
  useLayoutEffect(() => { settleRef.current = settle; });

  /** A program without a session record scrolls itself, as in any terminal. */
  const moveApplication = (lines: number) => session.scrollApplication(lines);
  const passWheel = (pixels: number) => {
    // About one wheel unit (three of the program's rows) per three rows of wheel travel.
    const next = programScrollUnits(wheelCarry.current, pixels, lineHeight * PROGRAM_ROWS_PER_UNIT);
    wheelCarry.current = next.carry;
    if (next.units) moveApplication(next.units);
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
      if (!wheeling.current) {
        wheeling.current = true;
        // As a drag does: a program may have started or quit since the last check.
        void session.inspectScrollMode();
        if (pixels > 0) retryApplicationHistory();
      }
      // A program screen frozen for the find bar scrolls here, not in the program.
      if (current.applicationScroll?.record === false && !(findOpen && current.browse)) { if (!readOnly) passWheel(pixels); return; }
      dragging.current = true;
      requestedOffset.current = null;
      // Heading back down: a return to the bottom leaves history even on a screen too short to scroll.
      if (pixels < 0) shortHistory.current = false;
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
    },
    end: () => { wheeling.current = false; settle(); },
  });

  /** "… 还有 N 行，点按展开" under a shortened tool output in record history. */
  const expanderFor = (line: PositionedLine) => {
    const expandable = browse?.expandable;
    if (!expandable?.size) return undefined;
    const id = expandable.get(allRows.length - 1 - line.rowFromBottom);
    if (!id) return undefined;
    let handler = expanders.current.get(id);
    if (!handler) { handler = () => session.expandRecordItem(id); expanders.current.set(id, handler); }
    return handler;
  };

  /** Freezes what is searched; returns whether the live screen was showing. */
  const freezeForSearch = () => {
    const current = session.getState();
    const live = !current.browse;
    // A full-screen program's whole conversation is searchable from its record.
    if (current.applicationScroll && current.applicationScroll.record !== false) {
      session.startApplicationHistory();
      void session.loadWholeRecord();
    } else session.startBrowsing({ freezeApplication: true });
    return live;
  };
  const closeFind = () => {
    setFindOpen(false);
    // Opened on the live screen and left there: live again. A match further up
    // stays in view, except on a program that scrolls itself: its wheel goes
    // back to the program.
    if (wasLiveBeforeFind.current && (lastFromBottom.current <= 2 || session.getState().applicationScroll?.record === false)) jumpToLive();
    onFindClosed?.();
  };
  const openOutput = () => {
    if (findOpen) closeFind();
    wasLiveBeforeTools.current = freezeForSearch();
    setToolsOpen(true);
  };
  const openFind = () => {
    if (!findOpen) {
      wasLiveBeforeFind.current = freezeForSearch();
      revealedMatch.current = '';
      setFindStep(0);
      setFindOpen(true);
    }
    setFindFocus((count) => count + 1);
  };
  const openTools = () => (inlineFind ? openFind() : openOutput());
  useImperativeHandle(ref, () => ({ openTools, openOutput }));

  // Matches: logical rows, newest first. Each match's lines are marked in the list.
  const needle = findOpen ? findNeedle(findQuery) : '';
  const searching = needle !== '';
  const plainRows = useMemo(() => (searching ? plainTerminalRows(allRows) : null), [searching, allRows]);
  const hits = useMemo(() => (plainRows ? matchingRows(plainRows, needle) : []), [plainRows, needle]);
  const hitRows = useMemo(() => new Set(hits.map((row) => allRows.length - 1 - row)), [hits, allRows.length]);
  const findCurrent = hits.length ? hits.length - 1 - (((findStep % hits.length) + hits.length) % hits.length) : -1;
  const currentMatchRow = findCurrent >= 0 ? hits[findCurrent] : -1;
  const currentMatchFromBottom = currentMatchRow >= 0 ? allRows.length - 1 - currentMatchRow : -1;
  useEffect(() => {
    if (!findOpen || currentMatchFromBottom < 0 || viewportHeight <= 0) return;
    const key = `${needle}#${currentMatchFromBottom}#${findStep}`;
    const index = firstLineOfRow(lines, currentMatchFromBottom);
    if (revealedMatch.current === key || index < 0) return;
    revealedMatch.current = key;
    // Centred, unless already clear of the find bar.
    const top = index * lineHeight, from = lastFromBottom.current;
    if (top < from || top + lineHeight > from + viewportHeight - FIND_BAR_CLEARANCE) {
      const range = Math.max(scrollRange.current, lines.length * lineHeight - viewportHeight, 0);
      const offset = Math.max(0, Math.min(range, top - (viewportHeight - lineHeight) / 2));
      lastFromBottom.current = offset;
      requestedOffset.current = offset;
      list.current?.scrollToOffset({ offset, animated: false });
    }
    if (!terminalWrap && plainRows) {
      // Unwrapped: also bring the match's column into view.
      const at = findRanges(plainRows[currentMatchRow], needle)[0]?.[0] ?? 0;
      const cell = size * MONO_ADVANCE_EM;
      const x = Array.from(plainRows[currentMatchRow].slice(0, at)).reduce((cells, char) => cells + codePointWidth(char.codePointAt(0)!), 0) * cell;
      const shown = horizontalOffset.current;
      if (x < shown || x + needle.length * cell > shown + width - SIDE_PADDING * 2) {
        const left = Math.max(0, x - width / 3);
        horizontalOffset.current = left;
        horizontal.current?.scrollTo({ x: left, animated: false });
      }
    }
  }, [findOpen, needle, findStep, currentMatchFromBottom, currentMatchRow, lines, lineHeight, viewportHeight, terminalWrap, plainRows, size, width]);

  // Desktop: rows above the terminal, the history row always there so the
  // terminal does not resize when browsing starts. Phone: one floating stack
  // at the bottom left, shown only while there is something to say; so is the
  // desktop window, whose header holds the tools.
  const floating = compact || toolsInHeader;
  const historyStatus = !floating || browse;
  const statusText = floating ? styles.floatingStatusText : styles.historyStatusText;
  // Phones: ↑↓ float at the right edge, away from a program's bottom-left
  // mode line; dragging the terminal does the same.
  const programButtons = applicationScroll?.record === false && !readOnly;
  const status = <>
    {state.restoringReading || state.readingNotice ? <Text style={[styles.readingNotice, floating && styles.floatingNotice]}>{state.restoringReading ? '正在恢复上次阅读的位置…' : state.readingNotice}</Text> : null}
    {applicationScroll?.record === false && !floating ? <View testID="terminal-application-scroll" style={styles.historyStatus}>
      <Text style={statusText}>{readOnly ? '这个程序的滚动需要终端控制权限' : '滚轮直接滚动程序（没有可读取的会话记录）'}</Text>
      {programButtons ? <>
        <Pressable testID="terminal-application-older" style={styles.historyLoad} hitSlop={LOAD_SLOP} onPress={() => moveApplication(3)} accessibilityRole="button" accessibilityLabel="查看程序内更早的历史"><Text style={styles.historyLoadText}>↑</Text></Pressable>
        <Pressable testID="terminal-application-newer" style={styles.historyLoad} hitSlop={LOAD_SLOP} onPress={() => moveApplication(-3)} accessibilityRole="button" accessibilityLabel="查看程序内更近的历史"><Text style={styles.historyLoadText}>↓</Text></Pressable>
      </> : null}
    </View> : null}
    {floating && programNotice ? <Text testID="terminal-program-notice" style={[styles.readingNotice, styles.floatingNotice]}>{programNotice}</Text> : null}
    {applicationScroll?.error ? <Text style={[styles.historyRetry, styles.edgeError, floating && styles.floatingNotice]}>{applicationScroll.error} · 请再次滑动重试</Text> : null}
    {applicationScroll?.record !== false && historyStatus ? <View testID={browse ? 'terminal-history-status' : undefined} style={[styles.historyStatus, floating ? styles.floatingStatus : styles.stableHistoryStatus]}>
      <Text style={statusText}>
        {!browse ? (applicationScroll ? '向上滑动查看会话记录' : '向上滑动查看历史')
          : browse.kind === 'application' ? `已读取会话记录 ${browse.olderRows.length} 行${browse.exhausted ? ' · 已到会话开头' : ''}`
          : browse.exhausted && browse.olderRows.length === 0
          ? `电脑只返回当前 ${browse.frozenRows.length} 行，未提供更早历史`
          : `已加载 ${browse.olderRows.length} 行历史${browse.exhausted ? ' · 已到本次起点' : ''}`}
      </Text>
      {browse && !browse.exhausted ? <Pressable testID="terminal-history-load" disabled={browse.loading || state.restoringReading}
        style={styles.historyLoad} hitSlop={LOAD_SLOP} onPress={() => void session.loadOlder({ retry: Boolean(browse.error) })} accessibilityRole="button">
        <Text style={styles.historyLoadText}>{browse.restartRequired ? '重新加载' : '加载更早'}</Text>
      </Pressable> : null}
    </View> : null}
    {browse?.error ? <Pressable testID="terminal-history-retry" style={[styles.historyRetry, floating && styles.floatingNotice]} hitSlop={LOAD_SLOP} onPress={() => void session.loadOlder({ retry: true })} accessibilityRole="button">
      <Text style={styles.edgeError}>{browse.error} · {browse.restartRequired ? '重新加载历史' : '重试'}</Text>
    </Pressable> : null}
  </>;

  // Unchanged lines keep their object, key and props, so a screen diff only redraws the lines it changed.
  const renderLine = ({ item }: { item: PositionedLine }) => {
    const match = hitRows.has(item.rowFromBottom);
    return <TerminalLine line={item} style={lineStyle} size={size} onPress={expanderFor(item) ?? tap}
      cursor={cursor && item.rowFromBottom === cursor.rowFromBottom && item.segmentFromBottom === 0 ? cursor.column : undefined}
      findNeedle={match ? needle : undefined} findCurrent={match && item.rowFromBottom === currentMatchFromBottom} />;
  };
  const terminalList = (
    <GestureDetector gesture={nativeScroll}>
    <FlatList
      ref={list}
      testID="terminal-output-list"
      style={styles.fill}
      inverted
      data={lines}
      keyExtractor={positionedLineKey}
      renderItem={renderLine}
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
      onScrollEndDrag={settle}
      onMomentumScrollBegin={() => { dragging.current = true; }}
      onMomentumScrollEnd={settle}
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

  const viewport = (
    <GestureDetector gesture={viewportGesture}>
      <View testID="terminal-viewport" style={styles.fill} onLayout={onViewportLayout}>
        {terminalWrap ? terminalList : (
          <ScrollView ref={horizontal} testID="terminal-horizontal-scroll" horizontal directionalLockEnabled nestedScrollEnabled alwaysBounceVertical={false} style={styles.fill}
            contentContainerStyle={{ width: contentWidth, height: viewportHeight }}
            onScroll={(event) => { horizontalOffset.current = event.nativeEvent.contentOffset.x; scheduleScrollEnd(); }} onScrollEndDrag={savePosition} scrollEventThrottle={32}>
            <View testID="terminal-raw-frame" style={{ width: contentWidth, height: viewportHeight }}>{terminalList}</View>
          </ScrollView>
        )}
      </View>
    </GestureDetector>
  );

  return (
    <View testID="terminal-output" style={styles.container} onLayout={onLayout}>
      {!floating ? <View style={styles.toolRow}>
        <Pressable style={styles.tools} onPress={() => setTerminalWrap(!terminalWrap)} accessibilityRole="button" accessibilityLabel={terminalWrap ? '切换为原始列宽' : '切换为自动折行'}><Text style={styles.toolsText}>{terminalWrap ? '自动折行' : '原始列宽 ↔'}</Text></Pressable>
        {inlineFind ? <View style={styles.toolGroup}>
          <Pressable style={styles.tools} onPress={openFind} accessibilityRole="button" accessibilityLabel="在终端输出中搜索"><Text style={styles.toolsText}>搜索</Text></Pressable>
          <Pressable style={styles.tools} onPress={openOutput} accessibilityRole="button" accessibilityLabel="复制终端输出"><Text style={styles.toolsText}>复制输出</Text></Pressable>
        </View> : <Pressable style={styles.tools} onPress={openTools} accessibilityRole="button" accessibilityLabel="搜索和复制终端输出">
          <Text style={styles.toolsText}>搜索 · 复制输出</Text>
        </Pressable>}
      </View> : null}
      {!floating ? status : null}
      {inlineFind ? <View style={styles.fill}>
        {viewport}
        {findOpen ? <TerminalFindBar query={findQuery} onChangeQuery={(query) => { setFindQuery(query); setFindStep(0); }} total={hits.length} current={findCurrent}
          onStep={(step) => setFindStep((current) => current + step)} onClose={closeFind} focusRequest={findFocus} /> : null}
      </View> : viewport}
      {lines.length === 0 && placeholder ? (
        <View testID="terminal-placeholder" style={styles.placeholder} pointerEvents="box-none">
          <Text style={styles.placeholderText}>{placeholder}</Text>
          {placeholderAction ? <Pressable testID="terminal-placeholder-action" onPress={placeholderAction.onPress} style={({ pressed }) => [styles.placeholderButton, pressed && styles.placeholderButtonPressed]}
            accessibilityRole="button" accessibilityLabel={placeholderAction.label}>
            <Text style={styles.placeholderButtonText}>{placeholderAction.label}</Text>
          </Pressable> : null}
        </View>
      ) : null}
      {floating ? <View testID="terminal-floating-status" style={styles.floating} pointerEvents="box-none">{status}</View> : null}
      {floating && programButtons ? (
        <View testID="terminal-application-scroll" style={styles.programRail} pointerEvents="box-none">
          <Pressable testID="terminal-application-older" style={({ pressed }) => [styles.programButton, pressed && styles.programButtonPressed]} hitSlop={4} onPress={() => moveApplication(3)}
            accessibilityRole="button" accessibilityLabel="向上滚动程序" accessibilityHint="也可以在终端上下滑动"><Text style={styles.programButtonText}>↑</Text></Pressable>
          <Pressable testID="terminal-application-newer" style={({ pressed }) => [styles.programButton, pressed && styles.programButtonPressed]} hitSlop={4} onPress={() => moveApplication(-3)}
            accessibilityRole="button" accessibilityLabel="向下滚动程序" accessibilityHint="也可以在终端上下滑动"><Text style={styles.programButtonText}>↓</Text></Pressable>
        </View>
      ) : null}
      {pinchSize !== null ? (
        <View style={styles.sizeBadge} pointerEvents="none">
          <Text style={styles.sizeBadgeText}>
            {pinchSize} pt · {columns} 列
          </Text>
        </View>
      ) : null}
      {browse ? (
        <Pressable style={styles.jump} hitSlop={JUMP_SLOP} onPress={jumpToLive} accessibilityRole="button" accessibilityLabel="回到最新输出">
          <Text style={styles.jumpText}>{browse.liveChanged ? '有新输出' : '回到底部'} ↓</Text>
        </Pressable>
      ) : null}
      {toolsOpen ? <TerminalTools visible onClose={() => { setToolsOpen(false); if (wasLiveBeforeTools.current) session.resumeLive(); }} state={state} session={session} /> : null}
    </View>
  );
}

type LineProps = {
  line: VisualLine; style: TextStyle; size: number; onPress: () => void; cursor?: number;
  /** Find bar: the normalized query, on lines of matching rows only; `findCurrent` on the selected match. */
  findNeedle?: string; findCurrent?: boolean;
};

const TerminalLine = memo(function TerminalLine({ line, style, size, onPress, cursor, findNeedle: needle, findCurrent = false }: LineProps) {
  const web = Platform.OS === 'web';
  // react-native-web gives a Text with `onPress` a pointing hand; a click handler keeps the text cursor.
  const press = (web ? { onClick: onPress } : { onPress }) as object;
  const text = { style, ...press, selectable: web, allowFontScaling: false, ...TERMINAL_LINE_DATA };
  if (cursor !== undefined) {
    const { before, at, after } = splitAtCursor(line.spans, cursor);
    return (
      <Text {...text} numberOfLines={1} ellipsizeMode="clip">
        {before.map((span, index) => <SpanText key={`b${index}`} span={span} size={size} />)}
        {/* Web: marked so the input method can compose at the cursor (terminalCursorAnchor). */}
        {web ? <Text {...TERMINAL_CURSOR_DATA}><SpanText span={at} size={size} mark={CURSOR_STYLE} /></Text> : <SpanText span={at} size={size} mark={CURSOR_STYLE} />}
        {after.map((span, index) => <SpanText key={`a${index}`} span={span} size={size} />)}
      </Text>
    );
  }
  if (line.spans.length === 0) return <Text {...text}> </Text>;
  const marked = needle ? markSpans(line.spans, needle) : null;
  if (marked?.some((span) => span.hit)) {
    const hit = findCurrent ? CURRENT_MATCH_STYLE : MATCH_STYLE;
    return (
      <Text {...text} numberOfLines={1} ellipsizeMode="clip">
        {marked.map((span, index) => <SpanText key={index} span={span} size={size} mark={span.hit ? hit : undefined} />)}
      </Text>
    );
  }
  if (line.spans.length === 1 && line.spans[0].attr === DEFAULT_ATTR && !web) {
    return <Text {...text} numberOfLines={1} ellipsizeMode="clip">{line.spans[0].text}</Text>;
  }
  return (
    <Text {...text} numberOfLines={1} ellipsizeMode="clip">
      {line.spans.map((span, index) => <SpanText key={index} span={span} size={size} />)}
    </Text>
  );
});

const CURSOR_STYLE: TextStyle = { backgroundColor: colors.ink, color: colors.terminal };
const MATCH_STYLE: TextStyle = { backgroundColor: 'rgba(224, 175, 104, 0.35)' };
const CURRENT_MATCH_STYLE: TextStyle = { backgroundColor: colors.yellow, color: colors.terminal };
/**
 * react-native-web draws `numberOfLines={1}` with `white-space: nowrap`, which
 * collapses runs of spaces (indentation, columns, boxes, the cursor's cell)
 * and ends a cut line with "…". Runs inside inherit `pre`.
 */
const WEB_LINE = { whiteSpace: 'pre', textOverflow: 'clip' } as unknown as TextStyle;

/** One styled run; on the web every non-GeistMono glyph gets a box of its terminal width. */
function SpanText({ span, size, mark }: { span: Span; size: number; mark?: TextStyle }) {
  const attr = span.attr === DEFAULT_ATTR ? null : styleForAttr(span.attr);
  const style = mark ? [attr, mark] : attr;
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

/** Gestures on the web: a pause in scroll events this long ends one. */
const WEB_SCROLL_END_MS = 150;
/** A full repaint is checked once its frames settle, and at most this often. */
const REPAINT_SETTLE_MS = 250;
const REPAINT_INTERVAL_MS = 750;
/** The find bar covers the top of the terminal: a match under it is scrolled clear. */
const FIND_BAR_CLEARANCE = 44;

/** Shown above the oldest loaded line while browsing history. */
function HistoryEdge({ state, session }: { state: TerminalState; session: TerminalSession }) {
  const browse = state.browse;
  if (!browse) return null;
  let content;
  if (browse.loading) {
    content = <Text style={styles.edgeText}>正在加载更早的输出…</Text>;
  } else if (browse.error) {
    content = (
      <Pressable style={styles.edgeButton} onPress={() => void session.loadOlder({ retry: true })} accessibilityRole="button">
        <Text style={[styles.edgeText, styles.edgeError]}>{browse.error}（{browse.restartRequired ? '点按重新加载' : '点按重试'}）</Text>
      </Pressable>
    );
  } else if (browse.exhausted) {
    content = <Text style={styles.edgeText}>— 已到本次可读取的最早输出 —</Text>;
  } else {
    content = <Pressable style={styles.edgeButton} onPress={() => void session.loadOlder()} accessibilityRole="button"><Text style={styles.edgeText}>继续上滑或点按加载更早的输出</Text></Pressable>;
  }
  return <View style={styles.edge}>{content}</View>;
}

// Small history buttons keep their look; the slop brings each touch area to about 44 pt.
const LOAD_SLOP = { top: 9, bottom: 9, left: 6, right: 6 };
const JUMP_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

const styles = StyleSheet.create({
  toolRow: { flexDirection: 'row', justifyContent: 'space-between' },
  toolGroup: { flexDirection: 'row' },
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
  edge: { minHeight: 48, paddingVertical: 2, alignItems: 'center', justifyContent: 'center' },
  edgeButton: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center' },
  edgeText: { color: colors.muted, fontSize: 12 },
  edgeError: { color: colors.red },
  placeholder: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32 },
  placeholderText: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  placeholderButton: { minWidth: 96, minHeight: 44, paddingHorizontal: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceRaised },
  placeholderButtonPressed: { backgroundColor: colors.divider },
  placeholderButtonText: { color: colors.blue, fontSize: 15, fontWeight: '600' },
  programRail: { position: 'absolute', top: 0, bottom: 0, right: 6, justifyContent: 'center', gap: 10 },
  programButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    opacity: 0.9,
  },
  programButtonPressed: { backgroundColor: colors.divider },
  programButtonText: { color: colors.ink, fontSize: 17 },
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
