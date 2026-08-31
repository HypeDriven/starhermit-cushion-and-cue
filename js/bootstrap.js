/* Cushion & Cue — bootstrap: capability detection + UI init. */
import { init } from './ui.js';

function boot() {
  try {
    init();
  } catch (e) {
    const live = document.getElementById('sr-alert');
    if (live) live.textContent = 'Failed to start: ' + e.message;
    const main = document.getElementById('main');
    if (main) {
      const p = document.createElement('p');
      p.textContent = 'Something went wrong while starting the game: ' + e.message;
      main.prepend(p);
    }
    throw e;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
