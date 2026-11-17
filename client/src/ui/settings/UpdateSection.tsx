import { useState } from 'react';
import { Text, View } from 'react-native';

import { checkForUpdate, restartToUpdate, updateLabel, useDesktopUpdate } from '../../platform/desktopUpdate';
import { ActionRow, Section, settingsStyles as s } from './Section';

/** The Mac app's version and self-update; hidden where the app does not update itself. */
export function UpdateSection() {
  const status = useDesktopUpdate();
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const working = busy || status.state === 'checking' || status.state === 'downloading';
  const check = () => {
    setBusy(true);
    void checkForUpdate().catch(() => {}).finally(() => setBusy(false));
  };
  return (
    <Section title="应用更新" footnote="新版本会在后台自动下载安装，重启 Panecast 后生效。">
      <View style={s.row}>
        <View style={s.rowText}>
          <Text style={s.rowTitle}>Panecast 桌面版 {status.current}</Text>
          <Text style={s.rowDetail}>{updateLabel(status)}</Text>
        </View>
      </View>
      {status.state === 'ready'
        ? <ActionRow label={`立即重启，使用 ${status.version}`} onPress={() => { void restartToUpdate(); }} />
        : <ActionRow label={working ? '正在检查…' : '检查更新'} onPress={working ? () => {} : check} />}
    </Section>
  );
}
