import { memo, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextStyle,
} from 'react-native';
import { GestureDetector, usePinchGesture } from 'react-native-gesture-handler';

import type { TerminalSession, TerminalState } from '../session/terminalSession';
import { DEFAULT_ATTR } from '../terminal/ansi';
import { buildInvertedLines, LayoutCache, type VisualLine } from '../terminal/layout';
import { DEFAULT_FG, styleForAttr } from '../terminal/palette';
import { clampFontSize } from '../state/prefs';
import { colors, fonts, MONO_ADVANCE_EM } from './theme';

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
  /** Tap on the terminal: hide the keyboard. */
  onTap: () => void;
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
export function TerminalView({ session, state, fontSize, onFontSizeChange, placeholder, onTap }: Props) {
  const [width, setWidth] = useState(0);
  const [cache] = useState(() => new LayoutCache());
  const [pinchSize, setPinchSize] = useState<number | null>(null);
  const pinchBase = useRef(fontSize);
  const list = useRef<FlatList<VisualLine>>(null);
  const size = pinchSize ?? fontSize;
  const lineHeight = Math.round(size * 1.3);
  const columns = width > 0 ? terminalColumns(width, size) : 0;
  const browse = state.browse;
  const rows = browse ? browse.frozenRows : state.screen.rows;
  const olderRows = browse?.olderRows;

  const lines = useMemo(() => {
    if (columns === 0) return [];
    const current = buildInvertedLines(rows, columns, cache, { trimBottom: true });
    if (!olderRows || olderRows.length === 0) return current;
    return current.concat(buildInvertedLines(olderRows, columns, cache, { trimBottom: false }));
  }, [rows, olderRows, columns, cache]);

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

  const pinch = usePinchGesture({
    runOnJS: true,
    onActivate: () => {
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

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const fromBottom = contentOffset.y;
    if (!browse && fromBottom > lineHeight * 2) {
      session.startBrowsing();
      return;
    }
    if (browse && fromBottom <= 2) {
      session.resumeLive();
      return;
    }
    const fromTop = contentSize.height - layoutMeasurement.height - contentOffset.y;
    if (browse && fromTop < layoutMeasurement.height * 1.5) void session.loadOlder();
  };

  const jumpToLive = () => {
    list.current?.scrollToOffset({ offset: 0, animated: false });
    session.resumeLive();
  };

  return (
    <View style={styles.container} onLayout={onLayout}>
      <GestureDetector gesture={pinch}>
        <View style={styles.fill}>
          <Pressable style={styles.fill} onPress={onTap} accessible={false}>
            <FlatList
              ref={list}
              inverted
              data={lines}
              keyExtractor={keyForIndex}
              renderItem={({ item }) => <TerminalLine line={item} style={lineStyle} />}
              getItemLayout={(_, index) => ({ length: lineHeight, offset: lineHeight * index, index })}
              initialNumToRender={60}
              maxToRenderPerBatch={60}
              windowSize={9}
              onScroll={onScroll}
              scrollEventThrottle={32}
              alwaysBounceVertical
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              removeClippedSubviews={Platform.OS === 'android'}
              contentContainerStyle={styles.content}
              ListFooterComponent={browse ? <HistoryEdge state={state} session={session} /> : undefined}
            />
          </Pressable>
        </View>
      </GestureDetector>
      {lines.length === 0 && placeholder ? (
        <View style={styles.placeholder} pointerEvents="none">
          <Text style={styles.placeholderText}>{placeholder}</Text>
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
        <Pressable style={styles.jump} onPress={jumpToLive} accessibilityRole="button" accessibilityLabel="回到最新输出">
          <Text style={styles.jumpText}>{browse.liveChanged ? '有新输出' : '回到底部'} ↓</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function keyForIndex(_: VisualLine, index: number): string {
  return String(index);
}

const TerminalLine = memo(function TerminalLine({ line, style }: { line: VisualLine; style: TextStyle }) {
  if (line.spans.length === 0) {
    return <Text style={style} allowFontScaling={false}> </Text>;
  }
  if (line.spans.length === 1 && line.spans[0].attr === DEFAULT_ATTR) {
    return (
      <Text style={style} numberOfLines={1} ellipsizeMode="clip" allowFontScaling={false}>
        {line.spans[0].text}
      </Text>
    );
  }
  return (
    <Text style={style} numberOfLines={1} ellipsizeMode="clip" allowFontScaling={false}>
      {line.spans.map((span, index) => (
        <Text key={index} style={styleForAttr(span.attr)}>
          {span.text}
        </Text>
      ))}
    </Text>
  );
});

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
        <Text style={[styles.edgeText, styles.edgeError]}>{browse.error}（点按重试）</Text>
      </Pressable>
    );
  } else if (browse.exhausted) {
    content = <Text style={styles.edgeText}>— 已经是最早的输出 —</Text>;
  } else {
    content = <Text style={styles.edgeText}>继续上滑加载更早的输出</Text>;
  }
  return <View style={styles.edge}>{content}</View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.canvas },
  fill: { flex: 1 },
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
