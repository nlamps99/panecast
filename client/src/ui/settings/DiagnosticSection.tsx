import * as Clipboard from '../../platform/clipboard';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { appStore } from '../../state/appStore';
import { diagnose, diagnosticReport, type Diagnostic } from '../../state/diagnostics';
import { useMachine } from '../../state/hooks';
import { ConnectionGuide } from '../ConnectionGuide';
import { colors } from '../theme';
import { ActionRow, Section, settingsStyles as s } from './Section';

export function DiagnosticSection() {
  const machine = useMachine();
  const [rows, setRows] = useState<Diagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return <Section title="连接诊断">
    <ActionRow label={busy ? '正在检查连接…' : '运行连接自检'} onPress={() => {
      if (busy) return;
      setBusy(true); setMessage('');
      void diagnose(machine).then(setRows).catch(() => setMessage('自检失败，请重试')).finally(() => setBusy(false));
    }} />
    {rows.map((row) => <View key={row.name} style={s.row}>
      <View style={[s.dot, { backgroundColor: row.state === 'ok' ? colors.green : row.state === 'warning' ? colors.yellow : colors.red }]} />
      <View style={s.rowText}><Text style={s.rowTitle}>{row.name}{row.ms === undefined ? '' : ` · ${row.ms} ms`}</Text><Text style={s.rowDetail}>{row.detail}</Text></View>
    </View>)}
    <ActionRow label="立即重连" onPress={() => appStore.wake()} />
    {rows.length ? <ActionRow label="复制诊断结果" onPress={() => void Clipboard.setStringAsync(diagnosticReport(rows)).then((ok) => setMessage(ok ? '已复制诊断结果' : '复制失败')).catch(() => setMessage('复制失败'))} /> : null}
    {message ? <View style={s.row}><Text style={s.rowDetail}>{message}</Text></View> : null}
    <View style={s.row}><ConnectionGuide /></View>
  </Section>;
}
