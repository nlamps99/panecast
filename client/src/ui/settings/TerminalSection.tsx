import { Switch, Text, View } from 'react-native';

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
import { Section, Stepper, settingsStyles as s } from './Section';

/** Terminal display and input preferences. */
export function TerminalSection() {
  const { fontSize, historyLines, keyHaptics, extraKeyRow } = usePrefs();
  return (
    <Section title="终端" footnote="也可以在终端上双指捏合调整字号。">
      <View style={s.row}>
        <Text style={[s.rowTitle, s.grow]}>字号</Text>
        <Text style={s.rowValue}>{fontSize} pt</Text>
        <Stepper label="A−" a11y="缩小字号" disabled={fontSize <= FONT_SIZE_MIN} onPress={() => setPrefs({ fontSize: fontSize - 1 })} />
        <Stepper label="A+" a11y="放大字号" disabled={fontSize >= FONT_SIZE_MAX} onPress={() => setPrefs({ fontSize: fontSize + 1 })} />
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
