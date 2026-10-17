// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Journey stage 1 and keeps playing hinted shots with the visible Hint / power / Shoot controls,
// letting every shot replay (rolling balls, pocket sparks, cue, aim guide and the post chain), placing
// the cue ball after fouls and retrying from the results card.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#btn-play', { timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#screen-settings:not([hidden])');
  await page.locator('#set-graphics').scrollIntoViewIfNeeded();
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.locator('#screen-settings .btn-back').click();
  await page.waitForSelector('#btn-play');
}

async function step(page) {
  const vis = (sel) => page.locator(sel + ':not([hidden])').count();
  if (await vis('#overlay-results')) { await page.click('#btn-retry'); return; }
  if (await vis('#btn-place')) { await page.click('#btn-hint').catch(() => {}); await page.click('#btn-place'); return; }
  if (await vis('#btn-shoot') && await page.locator('#btn-shoot').isEnabled()) {
    await page.click('#btn-hint');
    await page.locator('#power-slider').fill('700');
    await page.click('#btn-shoot');
  }
}

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.click('#setup-start');
  await page.waitForSelector('#btn-shoot:not([hidden])', { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch { if (!open) return; }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  await page.waitForTimeout(800);
}
