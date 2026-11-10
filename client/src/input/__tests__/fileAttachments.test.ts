import { uploadAttachments, type AttachmentFile } from '../fileAttachments';
import type { UploadedFile } from '../attachments';
import type { RpcChannel } from '../../session/terminalSession';
import { RpcCallError } from '../../protocol/connection';

function fixture() {
  const call = jest.fn(async (method: string, params?: Record<string, unknown>) => method === 'relay.info'
    ? { max_message_bytes: 24 * 1024 * 1024, max_upload_bytes: 12 * 1024 * 1024 }
    : { path: `/Downloads/${params?.filename}`, filename: params?.filename, mime_type: params?.mime_type });
  const channel = { call, transport: 'broker' } as unknown as RpcChannel;
  const target = { workspaceId: 'cmux~workspace', surfaceId: 'cmux~surface' };
  const callbacks = { progress: jest.fn(), uploaded: jest.fn(async (_file: UploadedFile) => {}), current: () => true };
  return { channel, call, target, callbacks };
}
const file = (name = '中文 文档.pdf', mimeType = 'application/pdf'): AttachmentFile => ({ name, mimeType, size: 3, readBase64: jest.fn(async () => 'AP+A') });

it('uploads original PNG and binary files in order to the selected terminal without sending commands', async () => {
  const f = fixture();
  expect(await uploadAttachments(f.channel, f.target, [file(), file('截图.png', 'image/png')], f.callbacks)).toBe(2);
  expect(f.call.mock.calls).toEqual([
    ['relay.info', { workspace_id: 'cmux~workspace', surface_id: 'cmux~surface' }, 5000],
    ['file.upload', { filename: '中文 文档.pdf', mime_type: 'application/pdf', data_base64: 'AP+A', workspace_id: 'cmux~workspace', surface_id: 'cmux~surface' }, 60000],
    ['file.upload', { filename: '截图.png', mime_type: 'image/png', data_base64: 'AP+A', workspace_id: 'cmux~workspace', surface_id: 'cmux~surface' }, 60000],
  ]);
  expect(f.callbacks.uploaded.mock.calls.map(args => args[0].path)).toEqual(['/Downloads/中文 文档.pdf', '/Downloads/截图.png']);
});

it('rejects oversized documents before reading, but compresses oversized images with the correct extension', async () => {
  const f = fixture(), large = { ...file(), size: 13 * 1024 * 1024 };
  await expect(uploadAttachments(f.channel, f.target, [large], f.callbacks)).rejects.toThrow('超过当前连接');
  expect(large.readBase64).not.toHaveBeenCalled();
  const image = { ...large, name: '图.png', mimeType: 'image/png', compressImage: jest.fn(async () => ({ base64: 'AP+A', width: 1, height: 1, quality: 0.78 })) };
  await uploadAttachments(f.channel, f.target, [image], f.callbacks);
  expect(f.call).toHaveBeenLastCalledWith('file.upload', expect.objectContaining({ filename: '图.jpg', mime_type: 'image/jpeg', data_base64: 'AP+A' }), 60000);
});

it('keeps the original routing when the selected target changes, and stops before uploading a cancelled read', async () => {
  const f = fixture(), selected = file();
  selected.readBase64 = async () => { f.target.surfaceId = 'a-different-terminal'; return 'AP+A'; };
  await uploadAttachments(f.channel, f.target, [selected], f.callbacks);
  expect(f.call).toHaveBeenLastCalledWith('file.upload', expect.objectContaining({ surface_id: 'cmux~surface' }), 60000);
  let current = true;
  selected.readBase64 = async () => { current = false; return 'AP+A'; };
  f.call.mockClear();
  expect(await uploadAttachments(f.channel, f.target, [selected], { ...f.callbacks, current: () => current })).toBe(0);
  expect(f.call.mock.calls.map(([method]) => method)).toEqual(['relay.info']);
});

it('preserves permission failures and uses the legacy size only for a missing capability', async () => {
  const f = fixture(), selected = file();
  f.call.mockRejectedValueOnce(new RpcCallError('source_revoked', '来源已撤销'));
  await expect(uploadAttachments(f.channel, f.target, [selected], f.callbacks)).rejects.toThrow('来源已撤销');
  expect(selected.readBase64).not.toHaveBeenCalled();
  f.call.mockRejectedValueOnce(new RpcCallError('method_not_found', '旧版本没有此接口'));
  expect(await uploadAttachments(f.channel, f.target, [selected], f.callbacks)).toBe(1);
});
