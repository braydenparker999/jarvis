import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright-core';

const chromePaths = [process.env.JARVIS_CHROME, `${process.env.HOME}/.cache/ms-playwright/chromium-1194/chrome-linux/chrome`];
const executablePath = chromePaths.find(p => p && existsSync(p));
const root = resolve('public');
const folder = 'folder123456789';
const stamp = '2026-10-05T12:00:00Z';
const videoId = n => 'video0000000' + String(n).padStart(3, '0');
const files = Array.from({ length: 30 }, (_, i) => ({
  id: videoId(i),
  name: 'Preview channel - Test video number ' + (i + 1) + ' [abcdefghijk].webm',
  mimeType: 'video/webm', createdTime: stamp, modifiedTime: stamp,
  videoMediaMetadata: { durationMillis: '600000', width: 640, height: 360 },
}));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

test('My Media refinement: sticky toolbar, targets, progress, no clipping', {
  skip: executablePath ? false : 'Chromium not available',
  timeout: 120000,
}, async t => {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      let path = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!path.startsWith(root + sep) && path !== root) throw Error('outside public');
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
      res.end(await readFile(path));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });

  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());

  async function session(width, seedProgress = false) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 600, hasTouch: width < 600 });
    if (seedProgress) {
      await context.addInitScript(({ id }) => {
        localStorage.setItem('mymedia.progress.v1', JSON.stringify({ [id]: { t: 120, d: 600, done: false, at: 10 } }));
      }, { id: videoId(1) });
    }
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      if (url.origin === origin) {
        if (url.pathname === '/assets/drive-config.json') return json({ apiKey: 'AIza' + 'x'.repeat(35), videoFolderId: folder });
        return route.continue();
      }
      if (url.hostname === 'www.googleapis.com') {
        if (url.pathname.endsWith('/' + folder)) return json({ id: folder, name: 'Preview library', mimeType: 'application/vnd.google-apps.folder' });
        const q = url.searchParams.get('q') || '';
        if (q.includes(folder)) return json({ files: [{ id: 'channel1', name: 'Preview channel', mimeType: 'application/vnd.google-apps.folder' }, files[0], files[1]] });
        return json({ files: files.slice(2) });
      }
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/mymedia/');
    await page.locator('.feed-grid .video-tile').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('videos'));
    return { context, page, errors };
  }

  for (const width of [360, 390, 430]) {
    await t.test(`no horizontal clipping at ${width}px`, async () => {
      const { page, context, errors } = await session(width);
      const dims = await page.evaluate(() => ({ w: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(dims.scroll <= dims.w + 1, `scrollWidth ${dims.scroll} <= viewport ${dims.w}`);
      assert.deepEqual(errors, []);
      await context.close();
    });
  }

  await t.test('toolbar stays stuck while scrolling', async () => {
    const { page, context, errors } = await session(390);
    const before = await page.locator('#library-toolbar').evaluate(el => el.getBoundingClientRect().top);
    assert.ok(before > 100, 'toolbar starts below the fold area');
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForFunction(() => {
      const r = document.querySelector('#library-toolbar').getBoundingClientRect();
      return Math.abs(r.top - 64) < 2;
    });
    const stuck = await page.locator('#library-toolbar').evaluate(el => el.getBoundingClientRect().top);
    assert.ok(Math.abs(stuck - 64) < 2, `toolbar sticks at top:64px (got ${stuck})`);
    // Search still works from the stuck toolbar.
    await page.locator('#search').fill('number 5');
    await page.waitForFunction(() => document.querySelectorAll('.feed-grid .video-tile').length < 30);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test('touch targets meet 44px and menu stays separate from card link', async () => {
    const { page, context, errors } = await session(390);
    const sizes = await page.evaluate(() => {
      const rect = s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? Math.round(r.height) : 0; };
      return {
        search: rect('#search'),
        sort: rect('#sort'),
        filterChip: rect('#browse-filters button'),
        menu: rect('.feed-grid .video-menu'),
      };
    });
    for (const [name, h] of Object.entries(sizes)) assert.ok(h >= 44, `${name} is ${h}px >= 44px`);
    // The menu button is not inside the card anchor (no nested interactives).
    const nested = await page.evaluate(() =>
      [...document.querySelectorAll('.feed-grid .video-tile')].every(
        tile => !tile.querySelector('a.video-card button')));
    assert.ok(nested, 'menu buttons sit outside the card anchors');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test('resume progress is an accessible progressbar', async () => {
    const { page, context, errors } = await session(390, true);
    const bar = page.locator('.feed-grid .video-tile .bar[role="progressbar"]').first();
    await bar.waitFor();
    assert.equal(await bar.getAttribute('aria-valuenow'), '20');
    assert.equal(await bar.getAttribute('aria-valuemin'), '0');
    assert.equal(await bar.getAttribute('aria-valuemax'), '100');
    assert.match(await bar.getAttribute('aria-label'), /Watched 20 percent/);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
