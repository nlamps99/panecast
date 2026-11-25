import { describePairingInput } from '../pairingInput';

function key(fields: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(fields));
  return 'pcs1.' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

it('says nothing for an empty field', () => {
  expect(describePairingInput('  ')).toBeNull();
});

it('names a pairing link by its server host, never its codes', () => {
  const summary = describePairingInput('cmux://pair?server=https%3A%2F%2Fbroker.example%2Fcmux-remote&relay=mac&code=SECRET123');
  expect(summary).toEqual({ ok: true, text: '已识别：配对链接（服务器 broker.example）' });
  expect(summary?.text).not.toContain('SECRET123');
  expect(summary?.text).not.toContain('mac');
});

it('mentions LAN pairing when the link carries it', () => {
  const summary = describePairingInput('cmux://pair?server=https://b.example&relay=r&code=c&lan=http://192.168.1.2:4399&lancode=l');
  expect(summary?.text).toContain('同一 Wi-Fi');
  expect(summary?.text).not.toContain('192.168');
});

it('names a share key by its window, never its token', () => {
  const summary = describePairingInput(key({ v: 1, s: 'https://broker.example/cmux-remote', r: 'home', d: 'guest', t: 'token-xyz', n: '论文' }));
  expect(summary).toEqual({ ok: true, text: '已识别：「论文」的分享密钥（服务器 broker.example）' });
  expect(summary?.text).not.toContain('token-xyz');
});

it('flags broken and unknown input', () => {
  expect(describePairingInput('pcs1.!!!')).toEqual({ ok: false, text: expect.stringContaining('分享密钥不完整') });
  expect(describePairingInput('cmux://pair?server=https://b.example&relay=r')).toEqual({ ok: false, text: expect.stringContaining('配对链接不完整') });
  expect(describePairingInput('hello')).toEqual({ ok: false, text: expect.stringContaining('无法识别') });
});
