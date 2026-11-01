import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ConnectionStatus } from '../../protocol/connection';
import { appStore } from '../../state/appStore';
import { computerAddress, normalizeComputerName, type StoredComputer } from '../../state/computers';
import { useAppState, useConnectionStatus } from '../../state/hooks';
import { openPairing } from '../../state/pairingRoute';
import { confirmRemove, runOrAlert } from '../computerActions';
import { Icon } from '../Icon';
import { Sheet, SheetRow, useSheet } from '../Sheet';
import { statusColor, statusLabel } from '../status';
import { colors, fonts } from '../theme';
import { ActionRow, Section, settingsStyles as s } from './Section';

/** Paired computers: which one is in use, rename, remove, re-pair, add; leave the demo. */
export function ComputerSection() {
  const { machine, computers } = useAppState();
  const status = useConnectionStatus(machine?.channel ?? null);
  const sheet = useSheet();
  const [managedId, setManagedId] = useState<string | null>(null);
  if (!machine) return null;

  const demo = machine.mode === 'demo';
  const currentId = machine.computer?.id ?? null;
  const authFailed = !demo && status.state === 'auth_failed';
  const managed = computers.computers.find((c) => c.id === managedId) ?? null;

  const manage = (computerId: string) => {
    setManagedId(computerId);
    sheet.open();
  };

  return (
    <Section title="电脑" footnote={computers.computers.length > 0 ? '轻点一台电脑可以改名、切换或移除。' : undefined}>
      {demo ? (
        <View style={s.row}>
          <Icon name="demo" size={18} color={colors.yellow} />
          <View style={s.rowText}>
            <Text style={s.rowTitle}>演示电脑</Text>
            <Text style={s.rowDetail} numberOfLines={1}>
              演示数据，不会连接真实电脑
            </Text>
          </View>
          <View style={[s.dot, { backgroundColor: colors.yellow }]} />
          <Text style={s.rowValue}>演示</Text>
        </View>
      ) : null}

      {computers.computers.map((computer, index) => (
        <ComputerRow
          key={computer.id}
          computer={computer}
          status={computer.id === currentId ? status : null}
          divided={demo || index > 0}
          onPress={() => manage(computer.id)}
        />
      ))}

      {authFailed && currentId ? <ActionRow label="重新配对" onPress={() => openPairing(currentId)} /> : null}
      {demo ? <ActionRow label="退出演示" onPress={() => appStore.exitDemo()} /> : null}
      <ActionRow label="添加电脑" divided={demo || computers.computers.length > 0} onPress={() => openPairing()} />

      <Sheet visible={sheet.visible} title={managed?.name ?? '电脑'} onClose={() => sheet.close()} onClosed={sheet.onClosed}>
        {managed ? (
          <ManageComputer
            key={managed.id}
            computer={managed}
            current={managed.id === currentId}
            authFailed={authFailed && managed.id === currentId}
            close={sheet.close}
          />
        ) : null}
      </Sheet>
    </Section>
  );
}

/** `status` is set only for the computer in use; others have no live connection to report. */
function ComputerRow({
  computer,
  status,
  divided,
  onPress,
}: {
  computer: StoredComputer;
  status: ConnectionStatus | null;
  divided: boolean;
  onPress: () => void;
}) {
  const current = status !== null;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.row, divided && s.divided, pressed && s.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${computer.name}${current ? `，当前电脑，${statusLabel(status)}` : ''}`}
      accessibilityHint="改名、切换或移除"
    >
      <Icon name="computer" size={18} color={current ? colors.green : colors.inkDim} />
      <View style={s.rowText}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {computer.name}
        </Text>
        <Text style={s.rowDetail} numberOfLines={1}>
          {computerAddress(computer)}
        </Text>
      </View>
      {status ? (
        <>
          <View style={[s.dot, { backgroundColor: statusColor(status) }]} />
          <Text style={[s.rowValue, status.state === 'auth_failed' && styles.failed]}>{statusLabel(status)}</Text>
        </>
      ) : null}
      <Icon name="forward" size={13} color={colors.muted} />
    </Pressable>
  );
}

function ManageComputer({
  computer,
  current,
  authFailed,
  close,
}: {
  computer: StoredComputer;
  current: boolean;
  authFailed: boolean;
  close: (then?: () => void) => void;
}) {
  // Uncontrolled input: a controlled TextInput breaks Chinese IME composition.
  const [initialName] = useState(computer.name);
  const [draft, setDraft] = useState(computer.name);
  const changed = normalizeComputerName(computer, draft) !== computer.name;

  const save = () => {
    if (changed) runOrAlert(() => appStore.rename(computer.id, draft));
  };

  const remove = () => confirmRemove(computer, () => close(() => runOrAlert(() => appStore.remove(computer.id))));

  return (
    <View>
      <Text style={styles.meta} numberOfLines={2}>
        {computerAddress(computer)} · {computer.broker.relayId}
      </Text>
      <View style={styles.nameRow}>
        <TextInput
          defaultValue={initialName}
          onChangeText={setDraft}
          onSubmitEditing={save}
          placeholder={computer.broker.relayId}
          placeholderTextColor={colors.muted}
          returnKeyType="done"
          autoCorrect={false}
          maxLength={60}
          accessibilityLabel="电脑名称"
          style={styles.nameInput}
        />
        <Pressable
          onPress={save}
          disabled={!changed}
          style={({ pressed }) => [styles.save, (!changed || pressed) && styles.saveDim]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !changed }}
        >
          <Text style={styles.saveText}>保存</Text>
        </Pressable>
      </View>
      {current ? null : <SheetRow title="切换到这台电脑" onPress={() => close(() => runOrAlert(() => appStore.select(computer.id)))} />}
      {authFailed ? (
        <SheetRow
          title="重新配对"
          titleColor={colors.blue}
          detail="配对已失效，需要重新扫码"
          detailColor={colors.red}
          onPress={() => close(() => openPairing(computer.id))}
        />
      ) : null}
      <SheetRow title="移除这台电脑" titleColor={colors.red} detail="移除后要重新扫码才能连接" onPress={remove} />
    </View>
  );
}

const styles = StyleSheet.create({
  failed: { color: colors.red },
  meta: { color: colors.muted, fontSize: 12, fontFamily: fonts.mono, paddingHorizontal: 18, paddingBottom: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingBottom: 14 },
  nameInput: {
    flex: 1,
    color: colors.ink,
    fontSize: 15,
    height: 40,
    paddingHorizontal: 12,
    paddingVertical: 0,
    borderRadius: 8,
    backgroundColor: colors.surfaceSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.divider,
  },
  save: { height: 40, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blue },
  saveDim: { opacity: 0.5 },
  saveText: { color: colors.canvas, fontSize: 15, fontWeight: '600' },
});
