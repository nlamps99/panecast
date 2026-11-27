import { useState } from 'react';

import { Alert } from '../platform/alert';
import { RENAME_UNSUPPORTED, renameTerminal } from '../session/terminalRename';
import { describeError, type RpcChannel, type SurfaceTarget } from '../session/terminalSession';
import { NameDialog } from './NameDialog';

type Dialog = { key: number; open: boolean; target: SurfaceTarget; title: string };

/**
 * 重命名… and 恢复默认名称 from a terminal's right-click menu: `rename` asks
 * for the name, `clear` sends at once. Render `element` once. A source that
 * cannot rename says so; nothing is retried.
 */
export function useTerminalRename(deps: { channel: RpcChannel; workspaces: { refresh(): Promise<void> } }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const dismiss = () => setDialog((d) => (d ? { ...d, open: false } : d));
  const run = (target: SurfaceTarget, title: string | null) => {
    void renameTerminal(deps, target, title).then(
      (result) => { if (result === 'unsupported') Alert.alert(RENAME_UNSUPPORTED); },
      (error: unknown) => Alert.alert('重命名失败', describeError(error)),
    );
  };
  const rename = (target: SurfaceTarget, title: string) => setDialog((d) => ({ key: (d?.key ?? 0) + 1, open: true, target, title }));
  const clear = (target: SurfaceTarget) => run(target, null);
  const element = dialog ? <NameDialog
    key={dialog.key}
    visible={dialog.open}
    title="重命名终端"
    initialValue={dialog.title}
    placeholder="终端名称"
    confirmLabel="重命名"
    onCancel={dismiss}
    onSubmit={(title) => {
      dismiss();
      if (title !== dialog.title) run(dialog.target, title);
    }}
  /> : null;
  return { rename, clear, element };
}
