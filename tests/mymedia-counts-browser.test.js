import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join, resolve, extname} from 'node:path';
import {chromium} from 'playwright-core';

const chrome = process.env.JARVIS_CHROME;
const root = resolve('public');
const folder = 'folder123456789';
const stamp = '2026-10-05T12:00:00Z';
const videoId = n => 'video0000000' + String(n).padStart(3, '0');
const driveFiles = Array.from({length: 72}, (_, i) => ({
  id: videoId(i),
  name: `Preview channel - Building something ${i + 1} [abcdefghijk].webm`,
  mimeType: 'video/webm', createdTime: stamp, modifiedTime: stamp,
  videoMediaMetadata: {durationMillis: '120000', width: 640, height: 360}
}));
const seedVideos = driveFiles.map(f => ({id: f.id, name: f.name,
  title: f.name.replace(/\.webm$/, ''), folder: 'Preview library', duration: 120}));
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css'};

test('My Media count clarity: shown-of-total counts, separated #status, preserved flows',
  {skip: !chrome || !existsSync(chrome), timeout: 120000}, async t => {
  const policy = JSON.parse(await readFile(join(root, 'staticwebapp.config.json'), 'utf8'));
  const server = createServer(async (req, res) => {
    try {
      let path = resolve(root, '.' + new URL(req.url, 'http://local').pathname);
      if (!path.startsWith(root + '/') && path !== root) throw Error('outside public');
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
      let content = await readFile(path);
      if (extname(path) === '.html') {
        const routePath = '/' + path.slice(root.length + 1);
        const csp = (policy.routes.find(r => routePath.startsWith(r.route.replace('*', '')))?.headers?.['Content-Security-Policy'] || policy.globalHeaders['Content-Security-Policy']).replace(/frame-ancestors[^;]*(;|$)/g, '');
        content = content.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
      }
      res.writeHead(200, {'Content-Type': mime[extname(path)] || 'application/octet-stream'}); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox']}); }
  catch (error) { await new Promise(done => server.close(done)); throw error; }

  const json = data => ({contentType: 'application/json', body: JSON.stringify(data)});
  const driveRoutes = (configOk) => async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      if (url.pathname === '/assets/drive-config.json') {
        if (!configOk) return route.fulfill({status: 500, body: 'settings unavailable'});
        return route.fulfill(json({apiKey: 'AIza' + 'x'.repeat(35), videoFolderId: folder}));
      }
      return route.continue();
    }
    if (url.hostname === 'www.googleapis.com') {
      if (url.pathname.endsWith('/' + folder))
        return route.fulfill(json({id: folder, name: 'Preview library', mimeType: 'application/vnd.google-apps.folder'}));
      const q = url.searchParams.get('q') || '';
      if (q.includes(folder)) {
        if (url.searchParams.get('pageToken')) return route.fulfill(json({files: driveFiles.slice(30)}));
        return route.fulfill(json({files: driveFiles.slice(0, 30), nextPageToken: 'p2'}));
      }
      return route.fulfill(json({files: []}));
    }
    return route.abort();
  };
  const countText = page => page.$eval('.browse-count', el => el.textContent);
  const tiles = page => page.$$eval('.video-grid .video-tile', els => els.length);

  await t.test('focused results show shown-of-total wording when paginated', async () => {
    const context = await browser.newContext({viewport: {width: 1280, height: 844}});
    // 12 videos marked watched so the combined query+unwatched filter is meaningful.
    await context.addInitScript(ids => localStorage.setItem('mymedia.progress.v1',
      JSON.stringify(Object.fromEntries(ids.map(id => [id, {t: 0, d: 600, done: true, at: 1}])))),
      driveFiles.slice(0, 12).map(f => f.id));
    await context.route('**/*', driveRoutes(true));
    const page = await context.newPage();
    await page.goto(origin + '/mymedia/');
    await page.waitForSelector('.video-tile');
    const status = await page.$eval('#status', el => el.textContent);
    assert.match(status, /72 videos · updated/, '#status keeps library freshness, not result counts');
    assert.ok(!/of 72 videos/.test(status), '#status never carries the shown-of-total wording');

    await page.fill('#search', 'building');
    await page.waitForFunction(() => document.querySelector('.browse-count')?.textContent === '60 of 72 videos');
    assert.equal(await tiles(page), 60, 'only the first page is rendered');
    assert.equal(await countText(page), '60 of 72 videos');

    await page.click('#load-more');
    await page.waitForFunction(() => document.querySelector('.browse-count')?.textContent === '72 videos');
    assert.equal(await tiles(page), 72, 'after Show more the count is the plain total');

    await page.click('#unwatched-filter');
    await page.waitForFunction(() => document.querySelector('.browse-count')?.textContent === '60 videos');
    assert.equal(await countText(page), '60 videos', 'combined search + unwatched filter counts the filtered set');

    await page.fill('#search', 'zzz-no-such-video');
    await page.waitForSelector('.media-empty');
    assert.match(await page.$eval('.media-empty h2', el => el.textContent), /No matching videos/);
    assert.equal(await page.$('.browse-count'), null, 'empty results carry no count');

    await page.click('#all-videos');
    await page.waitForSelector('.video-tile');
    assert.equal(await page.$('.browse-count'), null, 'reset returns to the count-free explore feed');

    await page.click('#refresh');
    await page.waitForFunction(() => /72 videos · updated/.test(document.querySelector('#status').textContent));
    assert.match(await page.$eval('#status', el => el.textContent), /72 videos · updated/,
      'refresh restores the freshness summary');

    await page.fill('#search', 'building');
    await page.waitForSelector('.browse-count');
    assert.equal(await page.$eval('.browse-count', el => el.getAttribute('tabindex')), null,
      'the count is not keyboard-focusable');
    assert.equal(await page.$eval('.browse-count', el => el.tabIndex), -1);
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'P',
      'tabbing never lands on the count');
    await context.close();
  });

  await t.test('a failed settings fetch keeps the cached list in #status', async () => {
    const context = await browser.newContext({viewport: {width: 1280, height: 844}});
    await context.addInitScript(({key, library}) =>
      localStorage.setItem(key, JSON.stringify(library)),
      {key: 'mymedia.library.v1', library: {id: folder, name: 'Preview library', fetched: Date.now(), videos: seedVideos}});
    await context.route('**/*', driveRoutes(false));
    const page = await context.newPage();
    await page.goto(origin + '/mymedia/');
    await page.waitForSelector('.video-tile');
    assert.match(await page.$eval('#status', el => el.textContent), /Showing the last saved list\./,
      '#status reports the cached/offline state');
    await context.close();
  });

  await new Promise(done => server.close(done));
  await browser.close();
});
