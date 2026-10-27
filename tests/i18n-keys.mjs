// Key extraction for the i18n coverage test (also handy for listing keys):
// every T('…') / N('…') in the engine client (native/*.ts) and the content's
// display fields.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname;
const require = createRequire(import.meta.url);
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');

export function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const ternary = /(?<![\w.$])T\([^'"\n()]*?\?\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*:\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  for (const f of readdirSync(join(ROOT, 'native')).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROOT, 'native', f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    for (const m of src.matchAll(ternary)) { keys.add(unescape(m[1] ?? m[2])); keys.add(unescape(m[3] ?? m[4])); }
  }
  return keys;
}

export function contentKeys() {
  const C = require('../js/content.js');
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  C.THEMES.forEach((t) => add(t.name));
  C.JOURNEY.forEach((j) => { add(j.name, j.intro); (j.players || []).forEach((p) => add(p.name)); });
  C.CHALLENGES.forEach((c) => { add(c.name, c.blurb); (c.players || []).forEach((p) => add(p.name)); });
  C.LESSONS.forEach((l) => { add(l.title, l.outro); l.steps.forEach((s) => add(s.text)); });
  C.PRACTICE.forEach((p) => { add(p.name); (C.practiceConfig(p.id, 1).players || []).forEach((q) => add(q.name)); });
  C.ACHIEVEMENTS.forEach((a) => add(a.name, a.desc));
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()].filter((k) => /[A-Za-z]/.test(k)));
