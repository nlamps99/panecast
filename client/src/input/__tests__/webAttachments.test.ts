import { bindAttachmentEvents, browserFile } from '../webAttachments.web';
import type { AttachmentEvents } from '../webAttachments';

jest.mock('../attachImage', () => ({ encodeImage: jest.fn() }));

let dom: { window: Window & typeof globalThis };
let dispose: () => void;
let events: AttachmentEvents & { files: jest.Mock; error: jest.Mock };
const dragging = jest.fn();
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => typeof dom };
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const name of ['window', 'document', 'Element', 'HTMLTextAreaElement', 'FileReader']) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom.window as unknown as Record<string, unknown>)[name] });
  }
});
afterAll(() => dom.window.close());
beforeEach(() => {
  document.body.innerHTML = '<main id="panecast-terminal"><section id="chat"></section><textarea id="input"></textarea></main><div id="panecast-expanded-composer"><textarea id="expanded"></textarea></div><textarea id="elsewhere"></textarea>';
  events = { enabled: true, files: jest.fn(), error: jest.fn() }; dragging.mockClear();
  dispose = bindAttachmentEvents(() => events, dragging);
});
afterEach(() => dispose());

function transfer(files: File[], text = ''): DataTransfer {
  return { types: files.length ? ['Files', 'text/plain'] : ['text/plain'], files, items: files.map(file => ({ kind: 'file', getAsFile: () => file })), getData: () => text } as unknown as DataTransfer;
}
function send(kind: string, target: string, data: DataTransfer) {
  const event = new dom.window.Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data });
  document.getElementById(target)!.dispatchEvent(event); return event;
}
const png = () => new dom.window.File([Uint8Array.from([137, 80, 78, 71, 0, 255])], '截图.png', { type: 'image/png' });

it('receives OS file drops over the conversation and preserves original binary bytes', async () => {
  const image = png(), documentFile = new dom.window.File(['hello'], '文档.txt', { type: 'text/plain' });
  const data = transfer([image, documentFile]);
  expect(send('dragover', 'chat', data).defaultPrevented).toBe(true); expect(dragging).toHaveBeenLastCalledWith(true);
  expect(send('drop', 'chat', data).defaultPrevented).toBe(true); expect(dragging).toHaveBeenLastCalledWith(false);
  const files = events.files.mock.calls[0][0];
  expect(files.map((file: { name: string }) => file.name)).toEqual(['截图.png', '文档.txt']);
  expect(await files[0].readBase64()).toBe('iVBORwD/');
  expect(await files[1].readBase64()).toBe('aGVsbG8=');
});

it('pastes a screenshot once in either composer and leaves ordinary text paste untouched', () => {
  const data = transfer([png()], 'screenshot representation');
  expect(send('paste', 'input', data).defaultPrevented).toBe(true);
  expect(events.files).toHaveBeenCalledTimes(1); expect(events.files.mock.calls[0][0]).toHaveLength(1);
  expect(send('paste', 'expanded', data).defaultPrevented).toBe(true);
  expect(events.files).toHaveBeenCalledTimes(2);
  expect(send('paste', 'input', transfer([], '中文文本')).defaultPrevented).toBe(false);
  expect(events.files).toHaveBeenCalledTimes(2);
});

it('does not upload outside the terminal, after unmount, or while the target is unavailable', () => {
  const data = transfer([png()]);
  expect(send('paste', 'elsewhere', data).defaultPrevented).toBe(false);
  expect(send('drop', 'elsewhere', data).defaultPrevented).toBe(true); expect(events.files).not.toHaveBeenCalled();
  events.enabled = false; send('drop', 'chat', data); expect(events.files).not.toHaveBeenCalled(); expect(events.error).toHaveBeenCalled();
  dispose(); expect(send('paste', 'input', data).defaultPrevented).toBe(false);
});

it('reports a directory instead of uploading it as an empty file', () => {
  const data = transfer([png()]);
  Object.defineProperty(data, 'items', { value: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] });
  send('drop', 'chat', data); expect(events.files).not.toHaveBeenCalled(); expect(events.error).toHaveBeenCalledWith(expect.stringContaining('ZIP'));
});

it('keeps a small pasted PNG as PNG, with its original name and bytes', async () => {
  const file = browserFile(png());
  expect(file).toMatchObject({ name: '截图.png', mimeType: 'image/png', size: 6 });
  expect(await file.readBase64()).toBe('iVBORwD/');
});
