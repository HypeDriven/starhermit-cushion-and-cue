/**
 * Cushion & Cue — end-to-end playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system
 * Chrome), on desktop (1280x800) and mobile (390x844, touch) passes:
 *   home → journey list → help → settings → Play (journey stage 1,
 *   "First Stroke", solo clearance) → pause/resume → hint-aimed shots
 *   (canvas drag aim, power slider, spin pad, skip replay, undo) played
 *   through to the results overlay → progression persisted → home.
 *
 * Shots alternate between the visible Shoot button and the documented
 * keyboard controls (Enter = shoot/place, H = hint, U = undo), and the run
 * asserts the controls are re-enabled after every replay resolves — that
 * regressed once (refreshHUD ran before ackResolved, leaving Shoot/Hint/Undo
 * disabled for the rest of the game).
 *
 * The game is fully client-side; only /api/v1/time is used (optional daily
 * clock sync). The embedded static server answers it so the run needs no
 * backend. server.js in this repo is the StarHermit authoritative server and
 * is intentionally NOT used here.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, pass) => `/tmp/cushion-and-cue-e2e-${stage}-${pass}.png`;

// Benign headless-GPU console noise (from tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/typescript; charset=utf-8',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v1/time') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ now: new Date().toISOString(), epochMs: Date.now() }));
      return;
    }
    if (url.pathname === '/favicon.ico') {
      const ico = path.join(ROOT, 'favicon.svg');
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      fs.createReadStream(ico).pipe(res);
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// What can the player do right now, judging only by visible control state?
function probeUI() {
  if (!document.getElementById('overlay-results').hidden) return 'results';
  const shoot = document.getElementById('btn-shoot');
  if (shoot.hidden) return 'inhand';       // ball in hand: cue ball must be placed
  return 'shoot';
}

// Wait until the previous command has visibly settled: the shots counter
// changes (shot resolved), the results overlay appears, or ball-in-hand.
async function waitSettled(page, prevShots, timeout = 20000) {
  await page.waitForFunction((prev) => {
    if (!document.getElementById('overlay-results').hidden) return true;
    if (document.getElementById('btn-shoot').hidden) return true;
    return document.getElementById('rail-shots').textContent !== prev;
  }, prevShots, { timeout });
}

async function runPass(browser, pass, viewport, hasTouch) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${pass}] ${name}`);
  };

  try {
    await step('load + home menu visible', async () => {
      await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'load' });
      await page.waitForSelector('#screen-home:not([hidden])', { timeout: 15000 });
      await page.waitForSelector('#btn-play');
      await page.screenshot({ path: SHOT('home', pass) });
    });

    await step('journey list: 36 stages, only stage 1 unlocked', async () => {
      await page.click('#btn-journey');
      await page.waitForSelector('#screen-journey:not([hidden])');
      const cards = page.locator('#journey-list .card-btn');
      if (await cards.count() !== 36) throw new Error('expected 36 journey stages');
      if (await page.locator('#journey-list .card-btn:not([disabled])').count() !== 1) {
        throw new Error('expected exactly 1 unlocked stage on a fresh save');
      }
      await page.screenshot({ path: SHOT('journey', pass) });
      await page.locator('#screen-journey .btn-back').click();
    });

    await step('help screen opens and closes', async () => {
      await page.click('#btn-help');
      await page.waitForSelector('#screen-help:not([hidden])');
      if (await page.locator('#help-cards .help-card').count() < 5) throw new Error('help cards missing');
      await page.locator('#screen-help .btn-back').click();
      await page.waitForSelector('#screen-home:not([hidden])');
    });

    await step('settings apply and persist (theme, quality, contrast, motion)', async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#screen-settings:not([hidden])');
      await page.selectOption('#set-quality', 'low');        // kinder to swiftshader
      await page.selectOption('#set-theme', 'midnight');
      await page.check('#set-contrast');
      await page.check('#set-motion');
      const cls = await page.evaluate(() => ({
        contrast: document.body.classList.contains('high-contrast'),
        motion: document.body.classList.contains('reduced-motion'),
        saved: JSON.parse(localStorage.getItem('cushion-and-cue-settings-v1')),
      }));
      if (!cls.contrast || !cls.motion) throw new Error('settings classes not applied');
      if (cls.saved.theme !== 'midnight' || cls.saved.quality !== 'low') {
        throw new Error('settings not persisted: ' + JSON.stringify(cls.saved));
      }
      await page.screenshot({ path: SHOT('settings', pass) });
      await page.locator('#screen-settings .btn-back').click();
      await page.waitForSelector('#screen-home:not([hidden])');
    });

    await step('Play → setup for journey stage 1 (First Stroke)', async () => {
      await page.click('#btn-play');
      await page.waitForSelector('#screen-setup:not([hidden])');
      const title = await page.textContent('#setup-title');
      if (!/First Stroke/.test(title)) throw new Error('unexpected setup: ' + title);
      const players = await page.textContent('#setup-players');
      if (!/Solo/.test(players)) throw new Error('stage 1 should be solo, got: ' + players);
      await page.screenshot({ path: SHOT('setup', pass) });
    });

    await step('start → game screen with HUD and table', async () => {
      await page.click('#setup-start');
      await page.waitForSelector('#screen-game:not([hidden])');
      await page.waitForSelector('#btn-shoot:not([hidden])', { timeout: 10000 });
      const objective = await page.textContent('#hud-objective');
      if (!objective || !objective.trim()) throw new Error('HUD objective empty');
      if (await page.locator('#btn-shoot').isHidden()) throw new Error('shoot button not visible');
      await page.screenshot({ path: SHOT('game', pass) });
    });

    if (pass === 'mobile') {
      await step('objective drawer opens and closes on narrow layouts', async () => {
        const rail = page.locator('#rail-left');
        if (await rail.isVisible()) throw new Error('drawer should start closed on mobile');
        await page.click('#btn-rail');
        await rail.waitFor({ state: 'visible', timeout: 3000 });
        if (!(await page.textContent('#rail-objective-text')).trim()) throw new Error('drawer objective empty');
        await page.screenshot({ path: SHOT('drawer', pass) });
        await page.click('#btn-rail-close');   // reachable while the drawer covers the topbar
        await rail.waitFor({ state: 'hidden', timeout: 3000 });
      });
    }

    await step('pause and resume via the overlay', async () => {
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause:not([hidden])');
      await page.screenshot({ path: SHOT('pause', pass) });
      for (const backMethod of ['button', 'Escape']) {
        await page.click('#btn-pause-settings');
        await page.waitForSelector('#screen-settings:not([hidden])');
        if (backMethod === 'button') await page.locator('#screen-settings .btn-back').click();
        else await page.keyboard.press('Escape');
        await page.waitForSelector('#screen-game:not([hidden])');
        await page.waitForSelector('#overlay-pause:not([hidden])');
        if (!(await page.locator('#btn-resume').evaluate(el => el === document.activeElement))) {
          throw new Error('Returning from paused settings must focus Resume');
        }
      }
      await page.click('#btn-resume');
      await page.waitForSelector('#overlay-pause', { state: 'hidden' });
      if (!(await page.locator('#btn-shoot').isEnabled())) throw new Error('Shoot disabled after settings/resume');
    });

    await step('play the table out: hint aim + slider power + shoot until results', async () => {
      let undoChecked = false;
      let spinChecked = false;
      const host = page.locator('#canvas-host');
      for (let i = 0; i < 14; i++) {
        const st = await page.evaluate(probeUI);
        if (st === 'results') break;
        if (st === 'inhand') {
          // ball in hand (foul): H asks the hint for a spot, then Place here
          await host.focus();
          await page.keyboard.press('h');
          await page.waitForSelector('#btn-place:not([hidden])', { timeout: 5000 });
          await page.click('#btn-place');
          await page.waitForSelector('#btn-shoot:not([hidden])', { timeout: 5000 });
          continue;
        }
        if (i === 0) {
          // aim by dragging on the table, like a player would, before the hint refines it
          const box = await host.boundingBox();
          if (!box) throw new Error('canvas host has no box');
          await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.35, { steps: 6 });
          await page.mouse.up();
          const readout = await page.textContent('#aim-readout');
          if (!/Aim: \d/.test(readout)) throw new Error('drag did not set an aim: ' + readout);
        }
        if (!spinChecked) {
          spinChecked = true;
          const pad = page.locator('#spin-pad');
          const pb = await pad.boundingBox();
          await pad.click({ position: { x: pb.width * 0.8, y: pb.height * 0.3 } });
          const spin = await page.textContent('#spin-value');
          if (spin.trim() === 'No spin') throw new Error('spin pad click had no effect');
          await pad.click({ position: { x: pb.width / 2, y: pb.height / 2 } }); // back to center
        }
        // the visible controls must be usable on every shot, not just the first
        if (await page.locator('#btn-shoot').isDisabled()) {
          throw new Error(`Shoot button still disabled before shot ${i + 1}`);
        }
        if (await page.locator('#btn-hint').isDisabled()) {
          throw new Error(`Hint button still disabled before shot ${i + 1}`);
        }
        // alternate between the buttons and the documented keyboard controls
        const useButtons = i % 2 === 1;
        if (useButtons) await page.click('#btn-hint');
        else { await host.focus(); await page.keyboard.press('h'); }
        await page.locator('#power-slider').fill('700');      // enough pace to reach pockets
        const shotsBefore = await page.textContent('#rail-shots');
        if (useButtons) await page.click('#btn-shoot');
        else { await host.focus(); await page.keyboard.press('Enter'); }
        if (i === 0) await page.screenshot({ path: SHOT('play', pass) });
        // replay animation: use the visible Skip replay control when it appears
        try {
          await page.waitForSelector('#btn-skip:not([hidden])', { timeout: 2500 });
          await page.click('#btn-skip');
        } catch { /* trace finished before we could skip */ }
        await waitSettled(page, shotsBefore);
        const afterShot = await page.textContent('#rail-shots');

        if (!undoChecked) {
          undoChecked = true;
          if (await page.locator('#btn-undo').isDisabled()) {
            throw new Error('Undo button still disabled after a resolved shot');
          }
          await host.focus();
          await page.keyboard.press('u');                     // undo the shot
          await page.waitForTimeout(300);
          const shotsAfterUndo = await page.textContent('#rail-shots');
          if (shotsAfterUndo !== shotsBefore || shotsAfterUndo === afterShot) {
            throw new Error(`undo did not restore the pre-shot state (before=${shotsBefore}, after=${afterShot}, undone=${shotsAfterUndo})`);
          }
          await page.screenshot({ path: SHOT('undo', pass) });
        }
      }
      await page.waitForSelector('#overlay-results:not([hidden])', { timeout: 15000 });
    });

    await step('results overlay with headline, stars, breakdown', async () => {
      const headline = await page.textContent('#res-headline');
      if (!headline.trim()) throw new Error('empty results headline');
      console.log(`  [${pass}] headline: ${headline.trim()}`);
      const stars = await page.textContent('#res-stars');
      console.log(`  [${pass}] stars: ${stars.trim()} · detail: ${(await page.textContent('#res-detail')).trim()}`);
      if (await page.locator('#res-breakdown > div').count() < 5) throw new Error('breakdown rows missing');
      if (await page.locator('#btn-next').isHidden()) throw new Error('next-stage button should show after a journey stage');
      await page.screenshot({ path: SHOT('results', pass) });
    });

    await step('progression persisted to the save', async () => {
      const save = await page.evaluate(() => JSON.parse(localStorage.getItem('cushion-and-cue-save-v1')));
      if (!save || !save.lastSnapshot) throw new Error('save snapshot not written');
      console.log(`  [${pass}] journeyStars: ${JSON.stringify(save.journeyStars)} · career pots: ${save.careerPots}`);
    });

    await step('back home from results', async () => {
      await page.click('#btn-results-home');
      await page.waitForSelector('#screen-home:not([hidden])');
      const progress = await page.textContent('#home-progress');
      if (!/career pots/.test(progress)) throw new Error('home progress not updated');
      await page.screenshot({ path: SHOT('done', pass) });
    });
  } finally {
    if (errors.length) {
      throw new Error(`[${pass}] page errors:\n` + errors.join('\n'));
    }
    await context.close();
  }
}

const server = await startServer();
const PORT = server.address().port;
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

try {
  await runPass(browser, 'desktop', { width: 1280, height: 800 }, false);
  await runPass(browser, 'mobile', { width: 390, height: 844 }, true);
  console.log('\nE2E PASS — cushion-and-cue playable end-to-end on desktop and mobile, no page errors');
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
