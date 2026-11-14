import { confirmClose } from '../confirm';
import type { DesktopBridge } from '../desktop';

jest.mock('react-native', () => ({ Platform: { OS: 'web' }, Alert: { alert: jest.fn() } }));
const nativeDialog = jest.fn();
const browserConfirm = jest.fn(() => false);
const oldWindow = globalThis.window;
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    confirm: browserConfirm, panecastDesktop: { version: 1, dialog: nativeDialog } as unknown as DesktopBridge,
  } });
});
afterAll(() => Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: oldWindow }));

it('uses the native Mac dialog instead of WKWebView window.confirm', async () => {
  nativeDialog.mockResolvedValue(1);
  expect(await confirmClose('关闭终端？', '正在运行的程序会结束。')).toBe(true);
  expect(nativeDialog).toHaveBeenCalledWith({ title: '关闭终端？', message: '正在运行的程序会结束。', buttons: ['取消', '关闭'], cancelId: 0 });
  expect(browserConfirm).not.toHaveBeenCalled();
});
it('does not close on cancellation, invalid replies or a failed dialog', async () => {
  for (const reply of [0, -1, undefined]) {
    nativeDialog.mockResolvedValue(reply);
    expect(await confirmClose('关闭？', 'message')).toBe(false);
  }
  nativeDialog.mockRejectedValue(new Error('window disappeared'));
  expect(await confirmClose('关闭？', 'message')).toBe(false);
});
it('retains the browser confirmation outside the desktop shell', async () => {
  delete window.panecastDesktop;
  browserConfirm.mockReturnValue(true);
  expect(await confirmClose('关闭？', 'message')).toBe(true);
  expect(nativeDialog).not.toHaveBeenCalled();
});
