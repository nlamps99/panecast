import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View, type TextInputInstance } from 'react-native';

import type { WorkspaceInfo } from '../session/surfaces';
import { DialogModal, NameForm } from './NameDialog';
import { colors } from './theme';

export type WorkspaceMenuStage = 'menu' | 'rename' | 'close';

type Props = {
  workspace: WorkspaceInfo;
  stage: WorkspaceMenuStage;
  visible: boolean;
  onStage: (stage: WorkspaceMenuStage) => void;
  onDismiss: () => void;
  onRename: (title: string) => void;
  onClose: () => void;
};

/**
 * A workspace's long-press actions: 重命名 / 关闭, then the name field or the
 * close confirmation. These are stages of one modal because iOS cannot
 * present a second modal while the first is still animating away.
 */
export function WorkspaceMenu({ workspace, stage, visible, onStage, onDismiss, onRename, onClose }: Props) {
  const input = useRef<TextInputInstance>(null);
  return (
    <DialogModal
      visible={visible}
      placement={stage === 'rename' ? 'top' : 'bottom'}
      onDismiss={onDismiss}
      onShow={() => input.current?.focus()}
    >
      {stage === 'rename' ? (
        <NameForm
          title="重命名工作区"
          initialValue={workspace.title}
          placeholder="工作区名称"
          confirmLabel="重命名"
          onCancel={onDismiss}
          onSubmit={onRename}
          inputRef={input}
        />
      ) : (
        <View style={styles.sheet}>
          {stage === 'close' ? (
            <View style={styles.group}>
              <View style={styles.heading}>
                <Text style={styles.title} numberOfLines={2}>
                  关闭「{workspace.title}」？
                </Text>
                <Text style={styles.message}>这会在 Mac 上的 cmux 里关闭这个工作区，里面的终端也会关掉，正在运行的程序会被结束。</Text>
              </View>
              <SheetButton label="关闭工作区" destructive onPress={onClose} />
            </View>
          ) : (
            <View style={styles.group}>
              <View style={styles.heading}>
                <Text style={styles.title} numberOfLines={1}>
                  {workspace.title}
                </Text>
              </View>
              <SheetButton label="重命名" onPress={() => onStage('rename')} />
              <SheetButton label="关闭" destructive onPress={() => onStage('close')} />
            </View>
          )}
          <View style={styles.group}>
            <SheetButton label="取消" bold divided={false} onPress={onDismiss} />
          </View>
        </View>
      )}
    </DialogModal>
  );
}

function SheetButton({
  label,
  destructive,
  bold,
  divided = true,
  onPress,
}: {
  label: string;
  destructive?: boolean;
  bold?: boolean;
  divided?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.button, divided && styles.divided, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      <Text style={[styles.buttonText, destructive && styles.destructive, bold && styles.bold]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: 8 },
  group: { borderRadius: 14, backgroundColor: colors.surface, overflow: 'hidden' },
  heading: { gap: 6, paddingHorizontal: 16, paddingVertical: 14, alignItems: 'center' },
  title: { color: colors.inkDim, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  message: { color: colors.muted, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  button: { height: 54, alignItems: 'center', justifyContent: 'center' },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  pressed: { backgroundColor: colors.surfaceRaised },
  buttonText: { color: colors.blue, fontSize: 17 },
  destructive: { color: colors.red },
  bold: { fontWeight: '600' },
});
