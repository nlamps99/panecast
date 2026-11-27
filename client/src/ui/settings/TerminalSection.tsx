import { Switch, Text, View, useWindowDimensions } from 'react-native';

import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  HISTORY_LINES_MAX,
  HISTORY_LINES_MIN,
  HISTORY_LINES_STEP,
  setPrefs,
  usePrefs,
} from '../../state/prefs';
import { colors } from '../theme';
import { desktopBridge } from '../../platform/desktop';
import { shortcutLabel } from '../desktopShell';
import { desktopTerminalSize, zoomDesktopTerminal } from '../terminalZoom';
import { Section, Stepper, settingsStyles as s } from './Section';

/** Terminal display and input preferences. */
export function TerminalSection() {
  const prefs = usePrefs();
  const { fontSize, historyLines, keyHaptics, extraKeyRow, terminalWrap, tabletSidebar } = prefs;
  const { width, height } = useWindowDimensions();
  const desktop = desktopBridge() !== null;
  // The split view needs a tablet-sized screen (see TerminalScreen), so a phone never uses it.
  const canSplit = desktop || Math.min(width, height) >= 600;
  // The desktop terminal draws its own size (fitted to the window, or ⌘= / ⌘-): the steppers change that one.
  const size = desktop ? desktopTerminalSize(prefs) : fontSize;
  const step = (delta: 1 | -1) => (desktop ? zoomDesktopTerminal(delta) : setPrefs({ fontSize: fontSize + delta }));
  const footnote = desktop ? `也可以用 ${shortcutLabel('=')} / ${shortcutLabel('-')} 调整字号，${shortcutLabel('0')} 恢复为适应窗口。` : '也可以在终端上双指捏合调整字号。';
  return (
    <Section title="终端" footnote={footnote}>
      <View style={s.row}>
        <Text style={[s.rowTitle, s.grow]}>字号</Text>
        <Text style={s.rowValue}>{size} pt</Text>
        <Stepper label="A−" a11y="缩小字号" disabled={size <= FONT_SIZE_MIN} onPress={() => step(-1)} />
        <Stepper label="A+" a11y="放大字号" disabled={size >= FONT_SIZE_MAX} onPress={() => step(1)} />
      </View>
      <View style={[s.row, s.divided]}>
        <View style={s.rowText}>
          <Text style={s.rowTitle}>实时行数</Text>
          <Text style={s.rowDetail}>实时刷新的行数，更早的内容往上滑时加载</Text>
        </View>
        <Text style={s.rowValue}>{historyLines} 行</Text>
        <Stepper
          label="−"
          a11y={`减少到 ${historyLines - HISTORY_LINES_STEP} 行`}
          disabled={historyLines <= HISTORY_LINES_MIN}
          onPress={() => setPrefs({ historyLines: historyLines - HISTORY_LINES_STEP })}
        />
        <Stepper
          label="+"
          a11y={`增加到 ${historyLines + HISTORY_LINES_STEP} 行`}
          disabled={historyLines >= HISTORY_LINES_MAX}
          onPress={() => setPrefs({ historyLines: historyLines + HISTORY_LINES_STEP })}
        />
      </View>
      <SwitchRow title="按键震动" value={keyHaptics} onChange={(value) => setPrefs({ keyHaptics: value })} />
      <SwitchRow title="自动折行" detail="关闭后保留原始列宽，左右滑动查看表格和终端界面" value={desktop ? prefs.desktopTerminalWrap : terminalWrap} onChange={(value) => setPrefs(desktop ? { desktopTerminalWrap: value } : { terminalWrap: value })} />
      {canSplit ? <SwitchRow title="宽屏工作区侧栏" detail="宽度足够时并排显示工作区和终端；缩小窗口后自动收起" value={tabletSidebar} onChange={(value) => setPrefs({ tabletSidebar: value })} /> : null}
      <SwitchRow
        title="第二排按键"
        detail="ctrl、/ | ~ - _ `、翻页、行首行尾。点一下 ctrl，下一个键就带 Ctrl 发送"
        value={extraKeyRow}
        onChange={(value) => setPrefs({ extraKeyRow: value })}
      />
    </Section>
  );
}

function SwitchRow({
  title,
  detail,
  value,
  onChange,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={[s.row, s.divided]}>
      <View style={s.rowText}>
        <Text style={s.rowTitle}>{title}</Text>
        {detail ? <Text style={s.rowDetail}>{detail}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.divider, true: colors.green }}
        ios_backgroundColor={colors.divider}
        accessibilityLabel={title}
      />
    </View>
  );
}
