import { uploadAttachments, uploadId, type AttachmentFile } from '../fileAttachments';
import type { UploadedFile } from '../attachments';
import type { RpcChannel } from '../../session/terminalSession';
import { RpcCallError } from '../../protocol/connection';

function fixture() {
  const call = jest.fn(async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => method === 'relay.info'
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
  await expect(uploadAttachments(f.channel, f.target, [large], f.callbacks)).rejects.toThrow('超过这台电脑');
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

describe('relays that take chunked uploads', () => {
  const MiB = 1024 * 1024;
  function chunked(chunkBytes = 4 * MiB) {
    const f = fixture();
    f.call.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'relay.info') return { max_message_bytes: 24 * MiB, max_upload_bytes: 12 * MiB, upload_chunk_bytes: chunkBytes };
      if (params?.upload_id && !params.done) return { upload_id: params.upload_id, received: 0 };
      return { path: `/Downloads/${params?.filename}`, filename: params?.filename, bytes: 1, mime_type: params?.mime_type };
    });
    return f;
  }
  /** A file whose chunks are `size` bytes of zeros, read lazily. */
  const big = (size: number, name = 'video.mov', mimeType = 'video/quicktime') => {
    const readChunk = jest.fn(async (start: number, end: number) => Buffer.alloc(end - start).toString('base64'));
    return { name, mimeType, size, readBase64: jest.fn(async () => { throw new Error('never read whole'); }), readChunk } satisfies AttachmentFile;
  };

  it('sends a file far past the old limit as ordered chunks of the original bytes, without compressing it', async () => {
    const f = chunked(), file = big(30 * MiB, '演示.png', 'image/png');
    const image = { ...file, compressImage: jest.fn(async () => null) };
    expect(await uploadAttachments(f.channel, f.target, [image], f.callbacks)).toBe(1);
    const uploads = f.call.mock.calls.filter(([method]) => method === 'file.upload').map(([, params]) => params as Record<string, unknown>);
    expect(uploads.map(p => p.offset)).toEqual([0, 4, 8, 12, 16, 20, 24, 28].map(n => n * MiB));
    expect(new Set(uploads.map(p => p.upload_id)).size).toBe(1);
    expect(uploads.map(p => p.done)).toEqual([false, false, false, false, false, false, false, true]);
    expect(uploads.every(p => p.workspace_id === 'cmux~workspace' && p.surface_id === 'cmux~surface')).toBe(true);
    expect(uploads[7]).toMatchObject({ filename: '演示.png', mime_type: 'image/png' });
    expect(uploads[0].filename).toBeUndefined();
    expect(image.compressImage).not.toHaveBeenCalled();
    expect(file.readBase64).not.toHaveBeenCalled();
    expect(file.readChunk).toHaveBeenLastCalledWith(28 * MiB, 30 * MiB);
    expect(f.callbacks.progress).toHaveBeenCalledWith(expect.stringContaining('93%'));
    expect(f.callbacks.uploaded).toHaveBeenCalledWith(expect.objectContaining({ path: '/Downloads/演示.png' }));
  });

  it('sends an empty file as one done chunk and keeps each chunk inside one message', async () => {
    const f = chunked(64 * MiB), empty = big(0, 'empty.txt', 'text/plain'), large = big(40 * MiB);
    await uploadAttachments(f.channel, f.target, [empty, large], f.callbacks);
    const uploads = f.call.mock.calls.filter(([method]) => method === 'file.upload').map(([, params]) => params as Record<string, unknown>);
    expect(uploads[0]).toMatchObject({ offset: 0, data_base64: '', done: true, filename: 'empty.txt' });
    const sizes = uploads.slice(1).map(p => Buffer.from(String(p.data_base64), 'base64').length);
    expect(Math.max(...sizes) * 4 / 3).toBeLessThan(24 * MiB);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(40 * MiB);
  });

  it('stops between chunks when the user moves on, and refuses a file that changed while reading', async () => {
    const f = chunked(), file = big(9 * MiB);
    let reads = 0;
    expect(await uploadAttachments(f.channel, f.target, [file], { ...f.callbacks, current: () => reads++ < 2 })).toBe(0);
    expect(f.call.mock.calls.filter(([method]) => method === 'file.upload')).toHaveLength(1);
    const shrunk = { ...big(9 * MiB), readChunk: jest.fn(async () => 'AAAA') };
    await expect(uploadAttachments(f.channel, f.target, [shrunk], f.callbacks)).rejects.toThrow('无法完整读取');
  });

  it('keeps the single-message path for a reader without chunks', async () => {
    const f = chunked();
    await uploadAttachments(f.channel, f.target, [file()], f.callbacks);
    expect(f.call).toHaveBeenLastCalledWith('file.upload', expect.objectContaining({ data_base64: 'AP+A' }), 60000);
  });

  it('makes ids the computer accepts as a file name', () => {
    expect(uploadId(bytes => bytes.fill(255))).toBe(`up-${'ff'.repeat(12)}`);
    expect(uploadId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
