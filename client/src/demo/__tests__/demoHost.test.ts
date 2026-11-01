import { DemoChannel } from '../demoChannel';
import { base64ByteLength, batterySnapshot, MAX_UPLOAD_BYTES, uploadFilename, uploadResult } from '../demoHost';
import { rpc, rpcError } from '../testing/demoHarness';

describe('demo host.battery', () => {
  it('has the relay HostBatterySnapshot shape and drains slowly', () => {
    expect(batterySnapshot(0, 0)).toEqual({
      available: true,
      percent: 76,
      state: 'discharging',
      is_charging: false,
      power_source: 'Battery Power',
    });
    expect(batterySnapshot(0, 30 * 60_000).percent).toBe(66);
    expect(batterySnapshot(0, 24 * 3_600_000).percent).toBe(20);
  });
});

describe('demo file.upload', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-01T09:08:07Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('returns the relay UploadedFileResult shape without keeping the data', async () => {
    const channel = new DemoChannel();
    const result = await rpc(channel, 'file.upload', {
      filename: 'IMG 0001.HEIC',
      mime_type: 'image/heic',
      data_base64: 'aGVsbG8gd29ybGQ=',
    });
    expect(result).toEqual({
      filename: '20261101-090807-IMG-0001.HEIC',
      path: '/Users/demo/Downloads/panecast/20261101-090807-IMG-0001.HEIC',
      bytes: 11,
      mime_type: 'image/heic',
    });
    expect(JSON.stringify(result)).not.toContain('aGVsbG8');

    const missing = await rpcError(channel, 'file.upload', { filename: 'a.png', mime_type: 'image/png' });
    expect(missing.code).toBe('upload_failed');
    const bad = await rpcError(channel, 'file.upload', { filename: 'a.png', mime_type: 'image/png', data_base64: 'not base64!' });
    expect(bad.code).toBe('upload_failed');
  });

  it('names files like RelayFileUploadService', () => {
    const at = Date.UTC(2026, 10, 1, 9, 8, 7);
    expect(uploadFilename('photo', 'image/png', at)).toBe('20261101-090807-photo.png');
    expect(uploadFilename('截图 1.png', 'image/png', at)).toBe('20261101-090807-截图-1.png');
    expect(uploadFilename('../../etc/passwd', 'image/jpeg', at)).toBe('20261101-090807-passwd.jpg');
    expect(uploadFilename('', 'image/heif', at)).toBe('20261101-090807-iphone-image.heic');
  });

  it('measures strict base64 and enforces the 12 MB cap', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('YQ==')).toBe(1);
    expect(base64ByteLength('YWI=')).toBe(2);
    expect(base64ByteLength('YWJj')).toBe(3);
    expect(base64ByteLength('YWJ')).toBeNull();
    expect(base64ByteLength('YW J')).toBeNull();
    expect(base64ByteLength('Y===')).toBeNull();
    const tooBig = 'A'.repeat(((MAX_UPLOAD_BYTES + 3) / 3) * 4);
    expect(() => uploadResult({ filename: 'big.jpg', mime_type: 'image/jpeg', data_base64: tooBig }, 0)).toThrow('超过 12 MB');
  });
});
