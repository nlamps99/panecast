import {
  AttachmentError,
  attachmentFilename,
  attachmentTimestamp,
  base64Budget,
  BROKER_BASE64_BUDGET,
  decodedByteLength,
  ENCODE_LADDER,
  encodeWithinBudget,
  fitWithin,
  formatBytes,
  parseRelayLimits,
  parseUploadResult,
  pathInsertion,
  planEncodeAttempts,
  RELAY_UPLOAD_MAX_BYTES,
  shellQuotePath,
  uploadParams,
  uploadTransportOf,
  type EncodeAttempt,
} from '../attachments';

describe('size budget', () => {
  it('keeps a broker upload frame under the relay tunnel’s 1 MiB message limit', () => {
    const budget = base64Budget('broker');
    expect(budget).toBe(BROKER_BASE64_BUDGET);
    // RPC JSON around the base64, then the broker's session.text envelope (JSON-escaped once more).
    const frameOverhead = 2_000;
    expect(budget + frameOverhead).toBeLessThan(1_000_000);
  });

  it('allows the legacy 6 MiB over LAN, within the relay’s decode limit', () => {
    const budget = base64Budget('lan');
    expect(decodedByteLength('A'.repeat(budget))).toBeGreaterThanOrEqual(6 * 1024 * 1024);
    expect((budget / 4) * 3).toBeLessThanOrEqual(RELAY_UPLOAD_MAX_BYTES);
  });

  it('uses the legacy 6 MiB through the broker when the relay reports large frames', () => {
    const limits = parseRelayLimits({ max_message_bytes: 24 * 1024 * 1024, max_upload_bytes: 12 * 1024 * 1024 });
    expect(limits).toEqual({ maxMessageBytes: 24 * 1024 * 1024, maxUploadBytes: 12 * 1024 * 1024 });
    expect(base64Budget('broker', limits)).toBe(base64Budget('lan'));
  });

  it('never exceeds a smaller reported frame or upload limit', () => {
    expect(base64Budget('broker', { maxMessageBytes: 2 * 1024 * 1024, maxUploadBytes: 12 * 1024 * 1024 })).toBe(
      2 * 1024 * 1024 - 64 * 1024,
    );
    expect(base64Budget('broker', { maxMessageBytes: 24 * 1024 * 1024, maxUploadBytes: 3 * 1024 * 1024 })).toBe(
      4 * 1024 * 1024,
    );
  });

  it('falls back to the 1 MiB-safe budget for relays without relay.info', () => {
    expect(parseRelayLimits(null)).toBeNull();
    expect(parseRelayLimits({ max_message_bytes: 'x' })).toBeNull();
    expect(base64Budget('broker', null)).toBe(BROKER_BASE64_BUDGET);
  });

  it('treats anything that is not a LAN channel as the broker', () => {
    expect(uploadTransportOf({ transport: 'lan' })).toBe('lan');
    expect(uploadTransportOf({ transport: 'broker' })).toBe('broker');
    expect(uploadTransportOf({})).toBe('broker');
    expect(uploadTransportOf(null)).toBe('broker');
  });

  it('counts decoded bytes from base64 length and padding', () => {
    expect(decodedByteLength('')).toBe(0);
    expect(decodedByteLength('YQ==')).toBe(1);
    expect(decodedByteLength('YWI=')).toBe(2);
    expect(decodedByteLength('YWJj')).toBe(3);
    expect(decodedByteLength('YWJjZA==')).toBe(4);
  });

  it('formats sizes for the busy message', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(850 * 1024)).toBe('850 KB');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB');
  });
});

describe('encode plan', () => {
  it('fits the long side and never scales up', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1179, 2556, 2048)).toEqual({ width: 945, height: 2048 });
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });

  it('walks the ladder for a large photo', () => {
    const attempts = planEncodeAttempts(2048, 1536);
    expect(attempts).toHaveLength(ENCODE_LADDER.length);
    expect(attempts[0]).toEqual({ width: 2048, height: 1536, quality: 0.78 });
    expect(attempts[3]).toEqual({ width: 1600, height: 1200, quality: 0.6 });
    expect(attempts[attempts.length - 1]).toEqual({ width: 1024, height: 768, quality: 0.4 });
  });

  it('only lowers the quality at a size it already tried', () => {
    const small = planEncodeAttempts(900, 600);
    // Every step fits at 900x600; 0.6 after 0.56 could not come out smaller.
    expect(small.map((a) => a.quality)).toEqual([0.78, 0.68, 0.56, 0.55, 0.4]);
    expect(small.every((a) => a.width === 900 && a.height === 600)).toBe(true);

    const medium = planEncodeAttempts(1500, 1000);
    expect(medium.map((a) => `${a.width}x${a.height}@${a.quality}`)).toEqual([
      '1500x1000@0.78',
      '1500x1000@0.68',
      '1500x1000@0.56',
      '1280x853@0.6',
      '1024x683@0.55',
      '1024x683@0.4',
    ]);
  });

  it('plans nothing for an image without a size', () => {
    expect(planEncodeAttempts(0, 600)).toEqual([]);
    expect(planEncodeAttempts(Number.NaN, 600)).toEqual([]);
  });

  it('returns the first encoding within the budget', async () => {
    const attempts = planEncodeAttempts(2048, 1536);
    const sizes = [1_200_000, 950_000, 880_000];
    const tried: EncodeAttempt[] = [];
    const result = await encodeWithinBudget(attempts, 900_000, async (attempt) => {
      tried.push(attempt);
      return 'A'.repeat(sizes[tried.length - 1]);
    });
    expect(tried).toHaveLength(3);
    expect(result?.quality).toBe(0.56);
    expect(result?.base64.length).toBe(880_000);
  });

  it('gives up rather than sending an oversized image', async () => {
    const encode = jest.fn(async () => 'A'.repeat(2_000_000));
    const attempts = planEncodeAttempts(2048, 1536);
    await expect(encodeWithinBudget(attempts, 900_000, encode)).resolves.toBeNull();
    expect(encode).toHaveBeenCalledTimes(attempts.length);
  });

  it('skips an empty encoding', async () => {
    const outputs = ['', 'abcd'];
    const result = await encodeWithinBudget(planEncodeAttempts(100, 100), 10, async () => outputs.shift() ?? '');
    expect(result?.base64).toBe('abcd');
  });
});

describe('filename and params', () => {
  const date = new Date(2026, 0, 2, 3, 4, 5);

  it('stamps local time like the legacy client', () => {
    expect(attachmentTimestamp(date)).toBe('20260102-030405');
    expect(attachmentTimestamp(new Date(2026, 11, 31, 23, 59, 58))).toBe('20261231-235958');
  });

  it('names the file after the platform', () => {
    expect(attachmentFilename(date, 'ios')).toBe('iphone-image-20260102-030405.jpg');
    expect(attachmentFilename(date, 'android')).toBe('android-image-20260102-030405.jpg');
    expect(attachmentFilename(date, 'web')).toBe('image-20260102-030405.jpg');
  });

  it('builds file.upload params with the relay’s snake_case keys', () => {
    expect(uploadParams('a.jpg', 'YWJj')).toEqual({ filename: 'a.jpg', mime_type: 'image/jpeg', data_base64: 'YWJj' });
  });
});

describe('upload result', () => {
  it('reads the relay result', () => {
    expect(
      parseUploadResult({
        filename: '20260102-030405-iphone-image.jpg',
        path: '/Users/me/Downloads/cmux-remote/20260102-030405-iphone-image.jpg',
        bytes: 123456,
        mime_type: 'image/jpeg',
      }),
    ).toEqual({
      filename: '20260102-030405-iphone-image.jpg',
      path: '/Users/me/Downloads/cmux-remote/20260102-030405-iphone-image.jpg',
      bytes: 123456,
      mimeType: 'image/jpeg',
    });
  });

  it('falls back on missing optional fields', () => {
    expect(parseUploadResult({ path: '/tmp/x/a.jpg' })).toEqual({
      filename: 'a.jpg',
      path: '/tmp/x/a.jpg',
      bytes: 0,
      mimeType: 'image/jpeg',
    });
  });

  it('rejects a result without a path', () => {
    expect(() => parseUploadResult(null)).toThrow(AttachmentError);
    expect(() => parseUploadResult({ filename: 'a.jpg' })).toThrow(AttachmentError);
    expect(() => parseUploadResult({ path: '' })).toThrow(AttachmentError);
  });
});

describe('path insertion', () => {
  const path = '/Users/me/Downloads/cmux-remote/20260102-030405-iphone-image.jpg';

  it('separates the path from the draft like appendPathToDraft, and leaves room to keep typing', () => {
    expect(pathInsertion('', path)).toBe(`${path} `);
    expect(pathInsertion('look at', path)).toBe(` ${path} `);
    expect(pathInsertion('look at ', path)).toBe(`${path} `);
    expect(pathInsertion('看一下\n', path)).toBe(`${path} `);
  });

  it('quotes paths a shell would split', () => {
    expect(shellQuotePath(path)).toBe(path);
    expect(shellQuotePath('/Users/中文/a.jpg')).toBe('/Users/中文/a.jpg');
    expect(shellQuotePath('/Users/John Doe/a.jpg')).toBe(`'/Users/John Doe/a.jpg'`);
    expect(shellQuotePath(`/tmp/it's.jpg`)).toBe(`'/tmp/it'\\''s.jpg'`);
    expect(pathInsertion('cat', '/a b.jpg')).toBe(` '/a b.jpg' `);
  });
});
