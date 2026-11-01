import { Text, View } from 'react-native';

import { FONT_SIZE_MAX, FONT_SIZE_MIN, setPrefs, usePrefs } from '../../state/prefs';
import { Section, Stepper, settingsStyles as s } from './Section';

/** Terminal display and input preferences. */
export function TerminalSection() {
  const { fontSize } = usePrefs();
  return (
    <Section title="终端" footnote="也可以在终端上双指捏合调整字号。">
      <View style={s.row}>
        <Text style={[s.rowTitle, s.grow]}>字号</Text>
        <Text style={s.rowValue}>{fontSize} pt</Text>
        <Stepper label="A−" a11y="缩小字号" disabled={fontSize <= FONT_SIZE_MIN} onPress={() => setPrefs({ fontSize: fontSize - 1 })} />
        <Stepper label="A+" a11y="放大字号" disabled={fontSize >= FONT_SIZE_MAX} onPress={() => setPrefs({ fontSize: fontSize + 1 })} />
      </View>
    </Section>
  );
}
