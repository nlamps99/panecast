import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';

const { webkit } = await import(process.env.PANECAST_PLAYWRIGHT_MODULE ?? 'playwright');
const directory = fileURLToPath(new URL('../../web/', import.meta.url));
const artifact = fileURLToPath(new URL('../../../build/activity-qa/', import.meta.url));
await mkdir(artifact, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/desktop-bridge.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL('./bridge.js', import.meta.url))); return; }
    const filename = resolve(directory, `.${path === '/' || !extname(path) ? '/index.html' : path}`);
    if (!filename.startsWith(directory)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.ttf': 'font/ttf', '.png': 'image/png' })[extname(filename)] ?? 'application/octet-stream');
    res.end(await readFile(filename));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await webkit.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(() => {
  const params = new URLSearchParams(location.search);
  window.__fixtureInitialTarget = params.get('initial') ?? 'a';
  window.__fixtureChat = params.get('chat') === '1';
  window.__fixtureLatency = Number(params.get('latency') ?? 0);
});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByTestId('terminal-output-list').waitFor();
  await page.waitForFunction(() => document.body.innerText.includes('HISTORY_ROW_2399'));
  await page.waitForFunction(() => window.panecastFixture.calls.filter(call => call.method.startsWith('terminal.conversation')).length >= 2);
  await page.evaluate(() => window.panecastFixture.run('b'));
  const a = page.getByRole('button', { name: '终端 A', exact: true }).first();
  const b = page.getByRole('button', { name: '终端 B', exact: true }).first();
  await b.getByTestId('terminal-running-indicator').waitFor();
  assert.ok(!(await b.innerText()).includes('正在处理'));
  await page.getByRole('button', { name: /窗口 2，/ }).getByTestId('terminal-running-indicator').waitFor();
  assert.ok((await b.boundingBox()).y < (await a.boundingBox()).y, 'Running terminal moves above the idle terminal');
  assert.match(await page.getByTestId('terminal-output-list').innerText(), /HISTORY_ROW_2399/, 'Background activity preserves the selected terminal');
  await page.screenshot({ path: `${artifact}/running.png` });
  await page.getByRole('button', { name: '返回工作区' }).click();
  await page.getByText('最近访问', { exact: true }).waitFor();
  const recent = page.getByText('最近访问', { exact: true }).locator('..');
  const recentButtons = recent.getByRole('button');
  assert.match(await recentButtons.first().innerText(), /终端 B/);
  await recent.getByRole('button', { name: /终端 A/ }).click();
  await page.getByTestId('terminal-output-list').waitFor();

  const list = page.getByTestId('terminal-output-list');
  await list.hover();
  await page.mouse.wheel(0, -160);
  await page.getByRole('button', { name: '回到最新输出' }).waitFor();
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -260); await page.waitForTimeout(80); }
  await page.waitForFunction(() => document.querySelector('[data-testid="terminal-output-list"]').scrollTop > 100);
  assert.ok(await page.evaluate(() => window.panecastFixture.calls.some(call => call.method === 'surface.history')));
  const before = await list.evaluate(node => ({ top: node.scrollTop, text: node.innerText }));
  assert.match(before.text, /HISTORY_ROW_2[0-2]\d\d/, 'Earlier text is rendered in WebKit');
  await page.evaluate(() => window.panecastFixture.output());
  await page.waitForTimeout(200);
  assert.equal(await list.evaluate(node => node.scrollTop), before.top, 'New output does not move the reading position');
  await page.screenshot({ path: `${artifact}/history.png` });

  await page.evaluate(() => window.panecastFixture.complete('b'));
  await page.waitForFunction(() => window.panecastFixture.notifications.some(item => item.surfaceId === 'b'));
  assert.equal(await page.evaluate(() => window.panecastFixture.notifications.length), 1);
  await page.screenshot({ path: `${artifact}/completed.png` });
  await page.evaluate(() => window.panecastFixture.run('b'));
  await b.getByTestId('terminal-running-indicator').waitFor();
  await page.evaluate(() => window.panecastFixture.complete('b'));
  await page.waitForFunction(() => window.panecastFixture.notifications.length === 2);
  await page.getByRole('button', { name: '回到最新输出' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="terminal-output-list"]').innerText.includes('LIVE_OUTPUT_WHILE_READING'));
  await b.click();
  await page.getByTestId('terminal-application-scroll').waitFor();
  await list.hover();
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -150); await page.waitForTimeout(100); }
  await page.waitForFunction(() => document.querySelector('[data-testid="terminal-output-list"]').innerText.includes('APP_HISTORY_0991'));
  assert.ok(await page.evaluate(() => window.panecastFixture.calls.some(call => call.method === 'terminal.scroll' && call.params.delta_lines > 0)));
  await page.screenshot({ path: `${artifact}/application-history.png` });

  await page.getByRole('button', { name: '回到最新输出' }).click();
  await page.evaluate(() => window.panecastFixture.complete('c'));
  await page.getByRole('button', { name: /窗口 2，/ }).click();
  await page.getByRole('button', { name: '终端 C', exact: true }).first().click();
  await page.getByRole('tab', { name: '对话模式', exact: true }).click();
  await page.getByTestId('terminal-chat-messages').getByText('会话 c 已完成 0', { exact: true }).waitFor();
  await page.getByRole('button', { name: /窗口 1，/ }).click();
  await a.click();
  await page.getByTestId('terminal-chat-messages').getByText('会话 a 已完成 0', { exact: true }).waitFor();
  await page.evaluate(() => window.panecastFixture.delay(2000));
  const start = Date.now();
  await page.getByRole('button', { name: /窗口 2，/ }).click();
  await page.getByRole('button', { name: '终端 C', exact: true }).first().click();
  await page.getByTestId('terminal-chat-messages').getByText('会话 c 已完成 0', { exact: true }).waitFor({ timeout: 500 });
  const switchMs = Date.now() - start;
  assert.ok(switchMs < 700, `Cached switch took ${switchMs} ms with a 2000 ms relay delay`);
  await page.screenshot({ path: `${artifact}/cached-switch.png` });
  // Let the coalesced IndexedDB writes commit, then start a new JS instance.
  await page.waitForTimeout(1800);
  const reloadStart = Date.now();
  await page.goto(`http://127.0.0.1:${server.address().port}/?initial=c&chat=1&latency=2000`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('terminal-chat-messages').getByText('会话 c 已完成 0', { exact: true }).waitFor({ timeout: 1500 });
  const reloadMs = Date.now() - reloadStart;
  assert.ok(reloadMs < 2000, `Disk cache did not beat the first network response: ${reloadMs} ms`);
  assert.equal(await page.evaluate(() => window.panecastFixture.notifications.length), 0, 'Restored history does not generate completion notifications');
  await page.screenshot({ path: `${artifact}/cache-restored.png` });
  await writeFile(`${artifact}/cache-performance.json`, JSON.stringify({ relayDelayMs: 2000, cachedWindowAndConversationSwitchMs: switchMs, restoredAfterReloadMs: reloadMs }, null, 2));
  assert.deepEqual(errors, []);
  console.log(`WebKit passed: inline rings across windows, notifications, history; cached switch ${switchMs} ms, relaunch ${reloadMs} ms with 2000 ms network delay.`);
} catch (error) {
  await page.screenshot({ path: `${artifact}/failure.png` });
  console.error('Page errors:', errors);
  console.error((await page.locator('body').innerText()).slice(0, 3500));
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
