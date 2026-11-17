// Trackpad scrolling through a full-screen program's history in WebKit.
//
// Run `npm run export` in `desktop/`, then `node e2e/scroll/verify.mjs` with
// Playwright and its WebKit browser installed (or PANECAST_PLAYWRIGHT_MODULE
// pointing at its index.mjs). It serves the exported app with the activity
// fixture (`../activity/bridge.js`): no real gateway, credentials or input.
//
// The fixture's program (alternate screen, mouse reporting, 9 rows per wheel
// unit, like Claude Code in cmux) redraws 15 ms after a wheel step, but the
// pushed frame arrives 250 ms later, as from a relay polling a quiet screen.
// Two swipes of 60 × 40 px must each move the list by the full 2400 px.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve } from 'node:path';

const { webkit } = await import(process.env.PANECAST_PLAYWRIGHT_MODULE ?? 'playwright');
const directory = fileURLToPath(new URL('../../web/', import.meta.url));
const artifact = fileURLToPath(new URL('../../../build/scroll-qa/', import.meta.url));
await mkdir(artifact, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/desktop-bridge.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL('../activity/bridge.js', import.meta.url))); return; }
    const filename = resolve(directory, `.${path === '/' || !extname(path) ? '/index.html' : path}`);
    if (!filename.startsWith(directory)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.ttf': 'font/ttf', '.png': 'image/png' })[extname(filename)] ?? 'application/octet-stream');
    res.end(await readFile(filename));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await webkit.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(() => { window.__fixtureInitialTarget = 'b'; window.__fixtureFrameDelay = 250; window.__fixtureApplicationStart = 6000; });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByTestId('terminal-application-scroll').waitFor();
  await page.waitForTimeout(1000);
  const list = page.getByTestId('terminal-output-list');
  const top = () => list.evaluate(node => Math.round(node.scrollTop));
  await list.hover();
  const swipe = async () => { for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, -40); await page.waitForTimeout(16); } };
  await swipe();
  const first = await top();
  assert.ok(first >= 2400 * 0.95, `First swipe moved ${first} of 2400 px`);
  await swipe();
  const second = await top();
  assert.ok(second - first >= 2400 * 0.95, `Second swipe moved ${second - first} of 2400 px`);
  // The list keeps only some lines in the DOM; check the ones on screen.
  const rows = await list.evaluate(node => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll('div')].filter(el => el.children.length === 0 || !el.querySelector('div'))
      .map(el => ({ rect: el.getBoundingClientRect(), match: /APP_HISTORY_(\d{4})/.exec(el.textContent ?? '') }))
      .filter(({ rect, match }) => match && rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom)
      .map(({ match }) => Number(match[1]));
  });
  const visible = [...new Set(rows)].sort((a, b) => a - b);
  assert.ok(visible.length >= 20, `Only ${visible.length} history lines on screen`);
  assert.deepEqual(visible.filter((row, index) => index && row !== visible[index - 1] + 1), [], 'Visible program history has no gaps');
  const steps = await page.evaluate(() => window.panecastFixture.calls.filter(call => call.method === 'terminal.scroll').map(call => call.params.delta_lines));
  assert.ok(steps.slice(1).some(step => step > 1), `Later steps are sized from the first: ${steps.slice(0, 6)}`);
  await page.screenshot({ path: `${artifact}/scrolled.png` });
  await page.getByRole('button', { name: '回到最新输出' }).click();
  await page.waitForFunction(() => window.panecastFixture.calls.some(call => call.method === 'terminal.scroll' && call.params.delta_lines < 0));
  const sent = await page.evaluate(() => window.panecastFixture.calls.filter(call => call.method === 'terminal.scroll').map(call => call.params.delta_lines));
  assert.equal(sent.reduce((total, delta) => total + delta, 0), 0, 'Leaving history scrolls the program back by exactly what was sent');
  assert.deepEqual(errors, []);
  console.log(`WebKit scroll passed: ${first} px and ${second - first} px of 2400 px per swipe, ${steps.length} program steps (${steps.slice(0, 4).join(', ')}, …).`);
} catch (error) {
  await page.screenshot({ path: `${artifact}/failure.png` });
  console.error('Page errors:', errors);
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
