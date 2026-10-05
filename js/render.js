/* Cushion & Cue — renderer (ES module).
 * Three.js top-down cue-hall scene when WebGL is available; a 2D canvas
 * top-down fallback otherwise so the game stays playable. Deterministic
 * decor via CCRNG STREAM_DECOR. Trace playback replays physics frames at
 * 60 Hz cosmetically; skipTrace()/completion always snaps to the exact
 * final frame, which matches the authoritative state.
 *
 * Graphics quality comes from CCGfx (js/gfx.js): presets + per-category
 * overrides, applied live by setGraphics() (shadow map, post chain
 * EffectComposer → GTAO → bloom → OutputPass → grade → SMAA/FXAA, pixel
 * ratio, detail, reflections, particles) with adaptive resolution.
 *
 * API: Render.create(host, opts) → {
 *   mode, setSnapshot(state), playTrace(trace, physics, {onPhysicsEvent,onDone}),
 *   skipTrace(), cancelTrace(), setAim(state, angleMilli|null), setLegalTargets(nums),
 *   setPlacement(on), setPlacementGhost(x,y|null), tablePointFromScreen(cx,cy),
 *   setTheme(theme), setGraphics(saved), graphicsInfo(), setHighContrast(b),
 *   setReducedMotion(b), resize(), dispose()
 * }
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const T = window.CCRules.TABLE;
const BALLS = window.CCContent.BALLS;
const Gfx = window.CCGfx;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function ballColor(n, hc) {
  const d = BALLS[n] || BALLS[0];
  return hc ? d.colorHC : d.color;
}
const hexCss = c => '#' + (c >>> 0).toString(16).padStart(6, '0');

/** Unmasked GPU name when the browser exposes it (for Auto + the summary). */
export function gpuName(gl) {
  try {
    const plain = gl.getParameter(gl.RENDERER);
    if (plain && !/^webkit webgl$/i.test(plain)) return String(plain);
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || plain || '');
    return String(plain || '');
  } catch (e) { return ''; }
}

// Colour grade + vignette (display-space colours in, display-space out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.3 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve, a touch more saturation, warm highlights / cool shadows.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.15, 0.8, l));
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.85));
      c *= 1.0 - uVignette * smoothstep(0.32, 0.8, d);
      gl_FragColor = vec4(c, src.a);
    }`
};

// ---------------------------------------------------------- textures -------
function canvasTex(w, h, draw, srgb) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  if (srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Ball skin: equirectangular map. The number disc sits on the equator at
// u = 0.25 (and 0.75); the mesh is turned so that point faces up. Stripes
// (9–15) get a white body with a coloured band through the number.
function ballTexture(n, hc) {
  return canvasTex(512, 256, (g, w, h) => {
    const col = hexCss(ballColor(n, hc));
    const stripe = n >= 9 && n <= 15;
    g.fillStyle = stripe || n === 0 ? (hc ? '#ffffff' : '#f6f1e6') : col;
    g.fillRect(0, 0, w, h);
    if (stripe) { g.fillStyle = col; g.fillRect(0, h * 0.5 - 66, w, 132); }
    if (n === 0) {
      g.fillStyle = hc ? '#d00000' : '#b8423a';
      for (const u of [0.25, 0.75]) { g.beginPath(); g.arc(w * u, h / 2, 7, 0, Math.PI * 2); g.fill(); }
      return;
    }
    for (const u of [0.25, 0.75]) {
      const x = w * u, y = h / 2;
      g.fillStyle = hc ? '#ffffff' : '#f6f1e6';
      g.beginPath(); g.arc(x, y, 22, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#141414';
      g.font = `bold ${n >= 10 ? 24 : 30}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(n), x, y + 2);
    }
  });
}

// Light wood grain (multiplied by the theme's wood colour).
function grainTexture(seed) {
  const rng = window.CCRNG.derive(seed || 1, window.CCRNG.STREAM_DECOR);
  const tex = canvasTex(512, 64, (g, w, h) => {
    g.fillStyle = '#e8e2da'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const y = rng.next() * h, a = 0.05 + rng.next() * 0.12, amp = 1 + rng.next() * 3, f = 0.004 + rng.next() * 0.01;
      g.strokeStyle = `rgba(60,36,20,${a})`;
      g.lineWidth = 0.6 + rng.next() * 1.6;
      g.beginPath();
      for (let x = 0; x <= w; x += 8) g.lineTo(x, y + Math.sin(x * f + i) * amp);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,245,230,0.08)';
    for (let i = 0; i < 6; i++) g.fillRect(0, rng.next() * h, w, 2 + rng.next() * 4);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Floor planks with per-board tone variation.
function plankTexture(seed) {
  const rng = window.CCRNG.derive((seed || 1) + 7, window.CCRNG.STREAM_DECOR);
  const tex = canvasTex(512, 512, (g, w, h) => {
    const rows = 8, rh = h / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rng.next() * 200;
      while (x < w) {
        const len = 180 + rng.next() * 220, t = 200 + Math.floor(rng.next() * 45);
        g.fillStyle = `rgb(${t},${t - 8},${t - 18})`;
        g.fillRect(x, r * rh, len, rh);
        g.strokeStyle = 'rgba(0,0,0,0.08)'; g.lineWidth = 1;
        for (let k = 0; k < 5; k++) {
          const yy = r * rh + rng.next() * rh;
          g.beginPath(); g.moveTo(x, yy); g.lineTo(x + len, yy + (rng.next() - 0.5) * 3); g.stroke();
        }
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, r * rh, 2, rh);
        x += len;
      }
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, r * rh, w, 2);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

// Rug under the table: field, border bands and corner lozenges in theme colours.
function rugTexture(p) {
  return canvasTex(512, 320, (g, w, h) => {
    const field = new THREE.Color(p.wall).lerp(new THREE.Color(p.accent), 0.08).multiplyScalar(0.85);
    g.fillStyle = '#' + field.getHexString(); g.fillRect(0, 0, w, h);
    g.strokeStyle = hexCss(p.accent); g.globalAlpha = 0.35;
    for (const [inset, lw] of [[10, 5], [24, 2], [34, 1]]) {
      g.lineWidth = lw; g.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
    }
    g.globalAlpha = 0.1;
    for (let x = 60; x < w - 40; x += 40) {
      for (let y = 60; y < h - 40; y += 40) {
        g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 8, y); g.lineTo(x, y + 8); g.lineTo(x - 8, y); g.closePath(); g.stroke();
      }
    }
    g.globalAlpha = 1;
  });
}

function blobTexture() {
  return canvasTex(64, 64, (g, w) => {
    const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, 'rgba(0,0,0,0.9)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.5)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
  }, false);
}

// Cue: tip, ferrule, maple shaft, brass joint, ebony butt (v runs butt → tip).
function cueTexture() {
  return canvasTex(4, 256, (g, w, h) => {
    const band = (a, b, c) => { g.fillStyle = c; g.fillRect(0, h - b * h, w, (b - a) * h); };
    band(0, 0.36, '#2a1a12');
    band(0.36, 0.38, '#c9a45a');
    band(0.38, 0.955, '#d8b98a');
    band(0.955, 0.985, '#d9d2c4');
    band(0.985, 1, '#4a78b8');
  });
}

// ---------------------------------------------------------------- 3D -------
function createThree(host, opts) {
  const gpu = opts.gpu || '';
  const detected = opts.detected || Gfx.detectPreset(gpu, false);
  let q = Gfx.resolve(opts.graphics || {}, detected);
  const canvasAA = q.antialias === 'msaa';
  const renderer = new THREE.WebGLRenderer({ antialias: canvasAA, alpha: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);
  const gpuLabel = gpu || gpuName(renderer.getContext());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 30);
  const CAM = { y: 2.05, z: 1.05 };           // slightly tilted top-down framing
  let camScale = 1;                           // widened by fitCamera() per aspect
  camera.position.set(0, CAM.y, CAM.z);
  camera.lookAt(0, 0, -0.08);

  let theme = opts.theme;
  let highContrast = !!opts.highContrast;
  let reducedMotion = !!opts.reducedMotion;
  const mqMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const motionOff = () => reducedMotion || !!(mqMotion && mqMotion.matches);
  let disposed = false;
  let shake = 0;
  let raf = 0;
  let clock = 0;

  const disposables = [];
  function track(o) { disposables.push(o); return o; }

  // ---- lights: warm key over the table (shadows fitted to the table),
  // hemisphere fill, and a soft spot pool that lets the room fall into shade.
  const hemi = new THREE.HemisphereLight(0xfff1dc, 0x1a1410, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e2, 1.5);
  key.position.set(0.35, 3, 0.55);
  scene.add(key); scene.add(key.target);
  {
    const sc = key.shadow.camera;
    sc.left = -1.62; sc.right = 1.62; sc.top = 1.02; sc.bottom = -1.02; sc.near = 1.5; sc.far = 4.5;
    sc.updateProjectionMatrix();
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.004;
  }
  const pool = new THREE.SpotLight(0xffe2b0, 4.2, 0, 0.8, 0.8, 2);
  pool.position.set(0, 2.3, 0);
  scene.add(pool); scene.add(pool.target);

  // ---- image-based lighting (reflections) ----
  let envTex = null;
  function ensureEnv() {
    if (envTex) return envTex;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment(renderer);
    envTex = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    track(envTex);
    return envTex;
  }

  // Detail textures, built once on first use.
  const tex = {};
  const getTex = (k, make) => tex[k] || (tex[k] = track(make()));

  // ---- environment group (rebuilt on theme / detail change) ----
  let envGroup = null;
  function disposeGroup(gp) {
    gp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  let rugTex = null;
  function buildEnvironment() {
    if (envGroup) { scene.remove(envGroup); disposeGroup(envGroup); }
    if (rugTex) { rugTex.dispose(); rugTex = null; }
    envGroup = new THREE.Group();
    const p = theme.palette;
    const detailed = q.detail === 'detailed';
    scene.background = new THREE.Color(p.fog);
    pool.color.set(p.light);
    key.color.set(p.light).lerp(new THREE.Color(0xffffff), 0.6);

    const floorMat = new THREE.MeshStandardMaterial({ color: p.floor, roughness: detailed ? 0.75 : 0.95, envMapIntensity: 0.1 });
    if (detailed) floorMat.map = getTex('plank', () => plankTexture(opts.decorSeed));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 7), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.78;
    floor.receiveShadow = true;
    envGroup.add(floor);

    if (detailed) {
      rugTex = rugTexture(p);
      const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 2.5),
        new THREE.MeshStandardMaterial({ map: rugTex, roughness: 1, envMapIntensity: 0.1 }));
      rug.rotation.x = -Math.PI / 2; rug.position.y = -0.775;
      rug.receiveShadow = true;
      envGroup.add(rug);
    }

    const wallMat = new THREE.MeshStandardMaterial({ color: p.wall, roughness: 0.9, envMapIntensity: 0.15 });
    const mkWall = (w, x, z, ry) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 2.4, 0.1), wallMat);
      wall.position.set(x, 0.4, z); wall.rotation.y = ry;
      envGroup.add(wall);
    };
    mkWall(9, 0, -2.6, 0); mkWall(9, 0, 2.6, 0);
    mkWall(7, -3.4, 0, Math.PI / 2); mkWall(7, 3.4, 0, Math.PI / 2);

    // deterministic decor: seeded frames/panels on the walls
    const decor = window.CCRNG.derive(opts.decorSeed || 1, window.CCRNG.STREAM_DECOR);
    const frameGeo = new THREE.BoxGeometry(0.5, 0.36, 0.03);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(frameGeo, new THREE.MeshStandardMaterial({
        color: decor.next() < 0.5 ? p.accent : p.metal, roughness: 0.6, metalness: 0.3
      }));
      const side = decor.int(2) ? -2.53 : 2.53;
      m.position.set(-3 + decor.next() * 6, 0.55 + decor.next() * 0.5, side);
      envGroup.add(m);
    }
    scene.add(envGroup);
  }

  // ---- table group ----
  const tableGroup = new THREE.Group();
  scene.add(tableGroup);
  const TABLE_TOP = 0;                        // cloth surface height
  let tableParts = [];
  // Authored felt weave (assets/cloth.webp), tinted by the theme's cloth
  // colour. Flat colour is the fallback while loading or if it fails.
  let clothTex = null;
  let clothMats = [];
  try {
    new THREE.TextureLoader().load('assets/cloth.webp', t => {
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.repeat.set(8, 4);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      clothTex = track(t);
      for (const m of clothMats) { m.map = t; m.needsUpdate = true; }
    }, undefined, () => { /* keep the flat cloth */ });
  } catch (e) { /* no loader (tests, old browsers): flat cloth */ }

  function feltMaterial(color, detailed) {
    const m = detailed
      ? new THREE.MeshPhysicalMaterial({ color, roughness: 0.9, sheen: 0.35, sheenRoughness: 0.8,
        sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.15), envMapIntensity: 0.12, map: clothTex })
      : new THREE.MeshStandardMaterial({ color, roughness: 0.92, map: clothTex });
    clothMats.push(m);
    return m;
  }

  let pocketMeshes = [];
  function buildTable() {
    for (const o of tableParts) {
      tableGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
    tableParts = [];
    clothMats = [];
    const p = theme.palette;
    const detailed = q.detail === 'detailed';
    const casts = q.shadows !== 'off';
    const add = mesh => { tableGroup.add(mesh); tableParts.push(mesh); return mesh; };

    const cloth = new THREE.Mesh(new THREE.BoxGeometry(T.PLAY_W + 0.24, 0.06, T.PLAY_H + 0.24),
      feltMaterial(p.cloth, detailed));
    cloth.position.y = TABLE_TOP - 0.03;
    cloth.receiveShadow = true;
    add(cloth);

    // cushions: 6 rail segments (gaps at pockets are cosmetic here)
    const railH = 0.055, railW = 0.09;
    const mkRail = (w, d, x, z) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, railH, d), feltMaterial(p.cushion, detailed));
      r.position.set(x, TABLE_TOP + railH / 2, z); r.castShadow = casts; r.receiveShadow = true;
      add(r);
    };
    const hx = T.PLAY_W / 2, hz = T.PLAY_H / 2;
    mkRail(T.PLAY_W / 2 - 0.12, railW, -(T.PLAY_W / 4 + 0.03), -hz - railW / 2);
    mkRail(T.PLAY_W / 2 - 0.12, railW, (T.PLAY_W / 4 + 0.03), -hz - railW / 2);
    mkRail(T.PLAY_W / 2 - 0.12, railW, -(T.PLAY_W / 4 + 0.03), hz + railW / 2);
    mkRail(T.PLAY_W / 2 - 0.12, railW, (T.PLAY_W / 4 + 0.03), hz + railW / 2);
    mkRail(railW, T.PLAY_H + 0.1, -hx - railW / 2, 0);
    mkRail(railW, T.PLAY_H + 0.1, hx + railW / 2, 0);

    // wood surround: lacquered grain on Detailed
    const woodH = 0.16, ext = 0.2;
    const mkWoodMat = alongZ => {
      if (!detailed) return new THREE.MeshStandardMaterial({ color: p.wood, roughness: 0.6 });
      const grain = getTex(alongZ ? 'grainZ' : 'grainX', () => {
        const t = grainTexture(opts.decorSeed);
        if (alongZ) { t.center.set(0.5, 0.5); t.rotation = Math.PI / 2; }
        return t;
      });
      return new THREE.MeshPhysicalMaterial({ color: p.wood, map: grain, roughness: 0.55,
        clearcoat: 0.5, clearcoatRoughness: 0.35, envMapIntensity: 0.25 });
    };
    const mkWood = (w, d, x, z, alongZ) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, woodH, d), mkWoodMat(alongZ));
      m.position.set(x, TABLE_TOP - woodH / 2 + 0.09, z); m.castShadow = casts; m.receiveShadow = true;
      add(m);
    };
    mkWood(T.PLAY_W + ext * 2 + 0.2, ext, 0, -hz - railW - ext / 2, false);
    mkWood(T.PLAY_W + ext * 2 + 0.2, ext, 0, hz + railW + ext / 2, false);
    mkWood(ext, T.PLAY_H + 0.2, -hx - railW - ext / 2, 0, true);
    mkWood(ext, T.PLAY_H + 0.2, hx + railW + ext / 2, 0, true);

    if (detailed) {
      // mother-of-pearl diamond sights inlaid in the rails
      const sightGeo = new THREE.CircleGeometry(0.011, 4);
      const sightMat = new THREE.MeshStandardMaterial({ color: 0xbfb49c, roughness: 0.5, envMapIntensity: 0.3 });
      const yTop = TABLE_TOP + 0.0905;
      const zRail = hz + railW + ext / 2, xRail = hx + railW + ext / 2;
      const sights = [];
      for (let k = 1; k <= 7; k++) if (k !== 4) { const x = -hx + k * T.PLAY_W / 8; sights.push([x, -zRail], [x, zRail]); }
      for (let k = 1; k <= 3; k++) { const z = -hz + k * T.PLAY_H / 4; sights.push([-xRail, z], [xRail, z]); }
      for (let i = 0; i < sights.length; i++) {
        const s = new THREE.Mesh(sightGeo, sightMat);
        s.rotation.x = -Math.PI / 2; s.rotation.z = Math.PI / 4;
        s.position.set(sights[i][0], yTop, sights[i][1]);
        add(s);
      }
    }

    // pockets: dark cylinders slightly below cloth (+ a leather lip on Detailed)
    pocketMeshes = [];
    for (const pk of T.POCKETS) {
      const r = pk.kind === 'corner' ? 0.075 : 0.065;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.8, 0.12, 24),
        new THREE.MeshStandardMaterial({ color: 0x070708, roughness: 1 }));
      m.position.set(pk.x, TABLE_TOP - 0.055, -pk.y);
      add(m);
      if (detailed) {
        const lip = new THREE.Mesh(new THREE.TorusGeometry(r, 0.006, 8, 28),
          new THREE.MeshPhysicalMaterial({ color: 0x1b120c, roughness: 0.45, clearcoat: 0.6, envMapIntensity: 0.6 }));
        lip.rotation.x = -Math.PI / 2;
        lip.position.set(pk.x, TABLE_TOP + 0.002, -pk.y);
        add(lip);
      }
      const glow = new THREE.Mesh(new THREE.RingGeometry(r + 0.005, r + 0.03, 24),
        new THREE.MeshBasicMaterial({ color: p.accent, transparent: true, opacity: 0, side: THREE.DoubleSide, toneMapped: false }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(pk.x, TABLE_TOP + 0.003, -pk.y);
      add(glow);
      pocketMeshes.push({ pocket: pk, glow });
    }
  }

  // ---- balls ----
  const ballGroup = new THREE.Group();
  scene.add(ballGroup);
  const ballGeoPlain = track(new THREE.SphereGeometry(T.R, 24, 18));
  const ballGeoDetailed = track(new THREE.SphereGeometry(T.R, 40, 28));
  const blobGeo = track(new THREE.PlaneGeometry(T.R * 3.4, T.R * 3.4));
  let ballViews = {};     // n -> {mesh, ring, blob}
  let legal = new Set();
  const ballTex = {};
  function getBallTex(n) {
    const k = n + (highContrast ? 'hc' : '');
    if (!ballTex[k]) {
      const t = ballTexture(n, highContrast);
      t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      ballTex[k] = track(t);
    }
    return ballTex[k];
  }

  function placeBall(v, x, y, visible) {
    v.mesh.visible = v.ring.visible = visible;
    if (v.blob) v.blob.visible = visible;
    if (!visible) return;
    v.mesh.position.set(x, TABLE_TOP + T.R, -y);
    v.ring.position.set(x, TABLE_TOP + 0.002, -y);
    if (v.blob) v.blob.position.set(x + 0.004, TABLE_TOP + 0.0015, -y + 0.004);
  }

  function rebuildBalls(state) {
    for (const n in ballViews) {
      const v = ballViews[n];
      ballGroup.remove(v.mesh, v.ring);
      v.mesh.material.dispose(); v.ring.geometry.dispose(); v.ring.material.dispose();
      if (v.blob) { ballGroup.remove(v.blob); v.blob.material.dispose(); }
    }
    ballViews = {};
    if (!state) return;
    const detailed = q.detail === 'detailed';
    for (const b of state.balls) {
      const map = getBallTex(b.n);
      const mat = detailed
        ? new THREE.MeshPhysicalMaterial({ map, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.5 })
        : new THREE.MeshStandardMaterial({ map, roughness: 0.25, metalness: 0.05 });
      const mesh = new THREE.Mesh(detailed ? ballGeoDetailed : ballGeoPlain, mat);
      mesh.rotation.x = -Math.PI / 2;   // number disc faces up
      mesh.castShadow = q.shadows !== 'off';
      // selection ring (grounded marker for legal targets)
      const ring = new THREE.Mesh(new THREE.RingGeometry(T.R * 1.25, T.R * 1.6, 24),
        new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0, side: THREE.DoubleSide, toneMapped: false }));
      ring.rotation.x = -Math.PI / 2;
      let blob = null;
      if (detailed) {
        blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
          map: getTex('blob', blobTexture), transparent: true, depthWrite: false,
          opacity: q.shadows !== 'off' ? 0.45 : 0.7 }));
        blob.rotation.x = -Math.PI / 2;
        ballGroup.add(blob);
      }
      ballGroup.add(ring);
      ballGroup.add(mesh);
      const v = { mesh, ring, blob };
      ballViews[b.n] = v;
      placeBall(v, b.x, b.y, !b.potted);
    }
  }

  // ---- cue stick + aim guide ----
  const cueStick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.011, 1.1, 16),
    track(new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: track(cueTexture()), roughness: 0.5, clearcoat: 0.4, envMapIntensity: 0.3 })));
  cueStick.visible = false;
  scene.add(cueStick);

  const aimMat = track(new THREE.LineBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.9, toneMapped: false }));
  const aimGeo = track(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]));
  const aimLine = new THREE.Line(aimGeo, aimMat);
  aimLine.visible = false;
  scene.add(aimLine);
  const ghost = new THREE.Mesh(track(new THREE.RingGeometry(T.R * 0.8, T.R, 24)),
    track(new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.7, side: THREE.DoubleSide, toneMapped: false })));
  ghost.rotation.x = -Math.PI / 2;
  ghost.visible = false;
  scene.add(ghost);

  // placement ghost cue ball
  const placeGhost = new THREE.Mesh(ballGeoPlain,
    track(new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 })));
  placeGhost.visible = false;
  scene.add(placeGhost);

  // ---- particles (pooled bursts) ----
  const POOL = 48;
  const particles = [];
  const pGeo = track(new THREE.SphereGeometry(0.008, 6, 5));
  for (let i = 0; i < POOL; i++) {
    const m = new THREE.Mesh(pGeo, track(new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, toneMapped: false })));
    m.visible = false;
    scene.add(m);
    particles.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0 });
  }
  let pNext = 0;
  function burst(x, z, color, count) {
    if (motionOff() || q.particles === 'off') return;
    const n = q.particles === 'high' ? count : Math.ceil(count / 2);
    for (let i = 0; i < n; i++) {
      const p = particles[pNext++ % POOL];
      const a = Math.random() * Math.PI * 2, sp = 0.3 + Math.random() * 0.7;
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = 0.8 + Math.random() * 0.8;
      p.life = 0.5;
      p.mesh.position.set(x, TABLE_TOP + T.R, z);
      p.mesh.material.color.set(color);
      p.mesh.material.opacity = 1;
      p.mesh.visible = true;
    }
  }

  // ---- ambient dust motes drifting in the lamp light ----
  const MOTES = 48;
  const moteGeo = track(new THREE.BufferGeometry());
  const motePos = new Float32Array(MOTES * 3), moteSeed = new Float32Array(MOTES);
  {
    const r = window.CCRNG.derive((opts.decorSeed || 1) + 3, window.CCRNG.STREAM_AV);
    // Motes hang over the rails and the room, never over the cloth, so they
    // cannot be mistaken for anything on the playing surface.
    for (let i = 0; i < MOTES; i++) {
      let x, z;
      do { x = (r.next() - 0.5) * 3.8; z = (r.next() - 0.5) * 2.4; } while (Math.abs(x) < 1.45 && Math.abs(z) < 0.85);
      motePos[i * 3] = x;
      motePos[i * 3 + 1] = 0.1 + r.next() * 0.5;
      motePos[i * 3 + 2] = z;
      moteSeed[i] = r.next() * 100;
    }
  }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, track(new THREE.PointsMaterial({
    color: 0xffe6c0, size: 0.006, transparent: true, opacity: 0.22, depthWrite: false,
    blending: THREE.AdditiveBlending
  })));
  motes.visible = false;
  scene.add(motes);
  function updateMotes(dt) {
    const on = q.particles !== 'off' && !motionOff();
    motes.visible = on;
    if (!on) return;
    motes.geometry.setDrawRange(0, q.particles === 'high' ? MOTES : 20);
    for (let i = 0; i < MOTES; i++) {
      const s = moteSeed[i];
      motePos[i * 3] += Math.sin(clock * 0.3 + s) * 0.004 * dt;
      motePos[i * 3 + 1] += (0.008 + Math.sin(clock * 0.21 + s * 1.7) * 0.006) * dt;
      motePos[i * 3 + 2] += Math.cos(clock * 0.25 + s) * 0.004 * dt;
      if (motePos[i * 3 + 1] > 0.7) motePos[i * 3 + 1] = 0.1;
    }
    moteGeo.attributes.position.needsUpdate = true;
  }

  // ---- trace playback ----
  let playing = null;
  function skipTrace() {
    if (!playing) return;
    const p = playing;
    playing = null;
    applyFrame(p.trace.frames[p.trace.frames.length - 1]);
    if (p.cbs.onDone) p.cbs.onDone();
  }
  function applyFrame(frame) {
    if (!lastState || !frame) return;
    for (let i = 0; i < lastState.balls.length; i++) {
      const b = lastState.balls[i];
      const v = ballViews[b.n];
      if (!v) continue;
      const x = frame[i * 2], y = frame[i * 2 + 1];
      if (x === null || x === undefined) placeBall(v, 0, 0, false);
      else placeBall(v, x, y, true);
    }
  }

  // ---- post-processing + adaptive resolution ----
  let composer = null, postKey = null, postFailed = false;
  let pixelRatio = 1, adaptiveScale = 1, size = [0, 0];
  let frames = [], fps = 0;

  function fpsMeter(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    if (el) el.hidden = !on;
  }

  function needsComposer() { return q.post || (q.antialias === 'msaa' && !canvasAA); }
  function makePostKey(w, h) {
    return needsComposer() && !postFailed ? [q.ao, q.bloom, q.grade, q.antialias, w, h, pixelRatio].join('|') : 'none';
  }
  function buildPost(w, h) {
    if (composer) {
      for (const pass of composer.passes) if (pass.dispose) pass.dispose();
      composer.renderTarget1.dispose(); composer.renderTarget2.dispose();
    }
    composer = null;
    if (!needsComposer() || postFailed) return;
    try {
      const pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0
      });
      const c = new EffectComposer(renderer, target);
      c.setPixelRatio(pixelRatio);
      c.setSize(w, h);
      c.addPass(new RenderPass(scene, camera));
      if (q.ao !== 'off') {
        const hiAO = q.ao === 'high';
        const ao = new GTAOPass(scene, camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.4, thickness: 0.06, scale: 1.0, samples: hiAO ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hiAO ? 6 : 4, rings: 2, samples: hiAO ? 16 : 8 });
        c.addPass(ao);
      }
      if (q.bloom === 'on') {
        // High threshold: only specular glints and bright highlights bloom.
        c.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.28, 0.35, 0.92));
      }
      c.addPass(new OutputPass());
      if (q.grade === 'on') c.addPass(new ShaderPass(GradeShader));
      if (q.antialias === 'smaa') c.addPass(new SMAAPass(pw, ph));
      if (q.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        c.addPass(fxaa);
      }
      composer = c;
    } catch (e) {
      // Post-processing is an enhancement: render directly if it cannot be built.
      postFailed = true;
      composer = null;
    }
  }

  function adapt(dtMs) {
    frames.push(dtMs);
    if (frames.length < 90) return false;
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    frames = [];
    fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(fps)} fps · ${Math.round(pixelRatio * 100) / 100}×`;
    if (!q.adaptive) return false;
    const before = adaptiveScale;
    if (avg > 26) adaptiveScale = Math.max(0.6, adaptiveScale - 0.1);
    else if (avg < 14 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + 0.05);
    return before !== adaptiveScale;
  }

  function applySize() {
    const w = host.clientWidth || 640, h = host.clientHeight || 480;
    // × UIScale: the canvas sits inside the zoomed #app, so its backing store must cover the zoom.
    const ratio = Math.min(window.devicePixelRatio || 1, q.cap) * ((window.UIScale && UIScale.value) || 1) * q.scale * adaptiveScale;
    if (w !== size[0] || h !== size[1] || ratio !== pixelRatio) {
      size = [w, h];
      pixelRatio = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fitCamera();
    }
    const k = makePostKey(w, h);
    if (k !== postKey) { postKey = k; buildPost(w, h); }
  }

  let lastState = null;
  let lastTime = performance.now();
  function loop(now) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const rawDt = now - lastTime;
    const dt = Math.min(0.05, rawDt / 1000);
    lastTime = now;
    if (!document.hidden && adapt(Math.min(250, rawDt))) applySize();
    clock += dt;

    if (playing) {
      const p = playing;
      const elapsed = Math.max(0, (now - p.start) / 1000);
      const fi = Math.min(p.trace.frames.length - 1, Math.floor(elapsed * 60));
      if (fi !== p.fi) { p.fi = fi; applyFrame(p.trace.frames[fi]); }
      // fire physics events whose sample tick has been reached
      const tickReached = fi * p.trace.every;
      while (p.pi < p.physics.length && p.physics[p.pi].tick <= p.tick0 + tickReached) {
        const e = p.physics[p.pi++];
        if (e.type === 'pocket') {
          const pk = T.POCKETS[e.pocket];
          burst(pk.x, -pk.y, 0xffe9a0, 14);
        }
        if (p.cbs.onPhysicsEvent) p.cbs.onPhysicsEvent(e);
      }
      if (fi >= p.trace.frames.length - 1) {
        playing = null;
        if (p.cbs.onDone) p.cbs.onDone();
      }
    }

    // particles
    for (const p of particles) {
      if (!p.mesh.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      p.vy -= 4 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y = Math.max(TABLE_TOP + 0.004, p.mesh.position.y + p.vy * dt);
      p.mesh.position.z += p.vz * dt;
      p.mesh.material.opacity = p.life * 2;
    }
    updateMotes(dt);

    // legal-target rings breathe gently (steady under reduced motion)
    const pulse = motionOff() ? 0.85 : 0.72 + 0.16 * Math.sin(clock * 3.2);
    for (const n in ballViews) {
      const v = ballViews[n];
      v.ring.material.opacity = legal.has(Number(n)) && v.mesh.visible ? pulse : 0;
    }

    // camera shake (big events only; never under reduced motion)
    const camY = CAM.y * camScale, camZ = CAM.z * camScale;
    if (shake > 0 && !motionOff()) {
      shake = Math.max(0, shake - dt * 2.5);
      const s = shake * 0.02;
      camera.position.set((Math.random() - 0.5) * s, camY + (Math.random() - 0.5) * s, camZ);
      camera.lookAt(0, 0, -0.08);
    } else if (camera.position.y !== camY || camera.position.x !== 0) {
      camera.position.set(0, camY, camZ);
      camera.lookAt(0, 0, -0.08);
    }

    if (composer) {
      try { composer.render(dt); }
      catch (e) { postFailed = true; postKey = null; applySize(); renderer.render(scene, camera); }
    } else renderer.render(scene, camera);
  }
  // ---- picking: screen → table coords via ground-plane raycast ----
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_TOP);
  const hit = new THREE.Vector3();
  function tablePointFromScreen(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera({ x: nx, y: ny }, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  // Pull the camera back until the whole table (cushions included) is inside
  // the frustum: a fixed height cropped the ends of the table on square and
  // portrait viewports, hiding balls and four of the six pockets.
  const FIT = new THREE.Vector3();
  function fitCamera() {
    const wx = T.PLAY_W / 2 + 0.13, wz = T.PLAY_H / 2 + 0.13;
    const corners = [[-wx, -wz], [wx, -wz], [-wx, wz], [wx, wz]];
    for (let i = 0; i < 10; i++) {
      camera.position.set(0, CAM.y * camScale, CAM.z * camScale);
      camera.lookAt(0, 0, -0.08);
      camera.updateMatrixWorld();
      let m = 0;
      for (const [x, z] of corners) {
        FIT.set(x, TABLE_TOP, z).project(camera);
        m = Math.max(m, Math.abs(FIT.x), Math.abs(FIT.y));
      }
      if (Math.abs(m - 0.94) < 0.01) break;
      camScale = clamp(camScale * (m / 0.94), 0.5, 6);
    }
  }

  function resize() { size = [0, 0]; applySize(); }

  // Apply resolved graphics settings live.
  let appliedDetail = null;
  function applyGraphics() {
    const shadowSize = Gfx.SHADOW_MAP[q.shadows];
    renderer.shadowMap.enabled = shadowSize > 0;
    key.castShadow = shadowSize > 0;
    if (shadowSize > 0 && key.shadow.mapSize.x !== shadowSize) {
      key.shadow.mapSize.set(shadowSize, shadowSize);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    scene.environment = q.reflections === 'on' ? ensureEnv() : null;
    const detailed = q.detail === 'detailed';
    pool.visible = detailed;
    hemi.intensity = detailed ? 0.4 : 1.0;
    key.intensity = detailed ? 1.0 : 1.6;
    buildEnvironment();
    buildTable();
    if (appliedDetail !== null && lastState) { const s = lastState; lastState = null; api.setSnapshot(s); }
    else for (const n in ballViews) {
      ballViews[n].mesh.castShadow = shadowSize > 0;
    }
    appliedDetail = q.detail;
    scene.traverse(o => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) m.needsUpdate = true;
    });
    renderer.domElement.dataset.gfxPreset = q.preset;
    fpsMeter(q.showFps);
    adaptiveScale = 1;
    frames = [];
    postFailed = false;
    postKey = null;
    resize();
  }

  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    if (opts.onContextLost) opts.onContextLost();
  });

  const api = {
    mode: '3d',
    setSnapshot(state) {
      const needRebuild = !lastState || !state ||
        lastState.balls.length !== state.balls.length ||
        state.balls.some((b, i) => lastState.balls[i].n !== b.n);
      if (needRebuild) rebuildBalls(state);
      lastState = state ? JSON.parse(JSON.stringify(state)) : null;
      if (state && !playing) {
        for (const b of state.balls) {
          const v = ballViews[b.n];
          if (v) placeBall(v, b.x, b.y, !b.potted);
        }
      }
    },
    playTrace(trace, physics, cbs) {
      const p = { trace, physics: physics || [], cbs: cbs || {}, start: performance.now(), fi: 0, pi: 0, tick0: lastState ? lastState.tick : 0 };
      playing = p;
    },
    skipTrace,
    // drop an in-flight playback without firing onDone (restart / leave game)
    cancelTrace() { playing = null; },
    setAim(state, angleMilli) {
      if (state == null || angleMilli == null || !state.balls[0] || state.balls[0].potted) {
        aimLine.visible = false; ghost.visible = false; cueStick.visible = false;
        for (const pm of pocketMeshes) pm.glow.material.opacity = 0;
        return;
      }
      const cue = state.balls[0];
      const a = angleMilli / 1000;
      const dx = Math.cos(a), dy = Math.sin(a);
      const prev = window.CCRules.aimPreview(state, angleMilli);
      const ex = prev ? prev.x : cue.x + dx * 1.5;
      const ey = prev ? prev.y : cue.y + dy * 1.5;
      aimGeo.setFromPoints([
        new THREE.Vector3(cue.x, TABLE_TOP + T.R, -cue.y),
        new THREE.Vector3(ex, TABLE_TOP + T.R, -ey)
      ]);
      aimLine.visible = true;
      if (prev && prev.ball != null) {
        ghost.position.set(prev.x, TABLE_TOP + 0.003, -prev.y);
        ghost.visible = true;
      } else ghost.visible = false;
      // cue stick behind the cue ball, opposite the aim direction
      cueStick.rotation.order = 'YXZ';
      cueStick.rotation.set(0.06, a, Math.PI / 2);
      cueStick.position.set(cue.x - dx * 0.62, TABLE_TOP + T.R + 0.05, -(cue.y) + dy * 0.62);
      cueStick.visible = true;
      // pocket glow near the aim end point
      for (const pm of pocketMeshes) {
        const ddx = pm.pocket.x - ex, ddy = pm.pocket.y - ey;
        pm.glow.material.opacity = (ddx * ddx + ddy * ddy < 0.16) ? 0.85 : 0;
      }
    },
    setLegalTargets(nums) { legal = new Set(nums || []); },
    setPlacement(on) { if (!on) placeGhost.visible = false; },
    setPlacementGhost(x, y) {
      if (x == null) { placeGhost.visible = false; return; }
      placeGhost.visible = true;
      placeGhost.position.set(x, TABLE_TOP + T.R, -y);
    },
    tablePointFromScreen,
    burstAt(x, y, color, big) {
      burst(x, -y, color || 0xffe9a0, big ? 22 : 10);
      if (big && !motionOff()) shake = 1;
    },
    setTheme(t) { theme = t; buildEnvironment(); buildTable(); },
    setGraphics(saved) {
      const next = Gfx.resolve(saved || {}, detected);
      if (JSON.stringify(next) === JSON.stringify(q) && appliedDetail !== null) return;
      q = next;
      applyGraphics();
    },
    graphicsInfo() {
      return {
        gpu: gpuLabel || 'unknown GPU', detected, resolved: q,
        pixels: [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)],
        summary: Gfx.describe(q, [Math.round(size[0] * pixelRatio), Math.round(size[1] * pixelRatio)]),
        fps: Math.round(fps), adaptiveScale: Math.round(adaptiveScale * 100) / 100, postFailed
      };
    },
    setHighContrast(b) {
      highContrast = !!b;
      if (lastState) { const s = lastState; lastState = null; api.setSnapshot(s); }
    },
    setReducedMotion(b) { reducedMotion = !!b; if (motionOff()) shake = 0; },
    resize,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      if (composer) for (const pass of composer.passes) if (pass.dispose) pass.dispose();
      for (const d of disposables) if (d.dispose) d.dispose();
      for (const k in tex) tex[k].dispose();
      renderer.dispose();
      fpsMeter(false);
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };

  applyGraphics();
  raf = requestAnimationFrame(loop);
  return api;
}

// ---------------------------------------------------------------- 2D -------
// Fallback when WebGL is unavailable: top-down canvas, same API.
function create2D(host, opts) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Pool table (2D view)');
  host.appendChild(canvas);
  const g = canvas.getContext('2d');
  let theme = opts.theme;
  let highContrast = !!opts.highContrast;
  let lastState = null;
  let aimMilli = null;
  let legalSet = new Set();
  let placeG = null;
  let scale = 1, ox = 0, oy = 0;
  let playing = null, raf = 0, disposed = false;

  // Match the 3D table: positive simulation Y appears toward the top.
  function toScreen(x, y) { return { x: ox + (x - T.MIN_X) * scale, y: oy + (T.MAX_Y - y) * scale }; }
  function resize() {
    const w = host.clientWidth || 640, h = host.clientHeight || 480;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * ((window.UIScale && UIScale.value) || 1);
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = '100%'; canvas.style.height = '100%';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = Math.min(w / (T.PLAY_W + 0.5), h / (T.PLAY_H + 0.5));
    ox = (w - T.PLAY_W * scale) / 2; oy = (h - T.PLAY_H * scale) / 2;
    draw();
  }
  function hex(c) { return '#' + c.toString(16).padStart(6, '0'); }

  let frameOverride = null;
  function draw() {
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 480;
    const p = theme.palette;
    g.fillStyle = hex(p.fog); g.fillRect(0, 0, w, h);
    const tl = toScreen(T.MIN_X - 0.2, T.MAX_Y + 0.2);
    const br = toScreen(T.MAX_X + 0.2, T.MIN_Y - 0.2);
    g.fillStyle = hex(p.wood); g.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    const cl = toScreen(T.MIN_X, T.MAX_Y), cr = toScreen(T.MAX_X, T.MIN_Y);
    g.fillStyle = hex(p.cloth); g.fillRect(cl.x, cl.y, cr.x - cl.x, cr.y - cl.y);
    g.fillStyle = '#0a0a0c';
    for (const pk of T.POCKETS) {
      const s = toScreen(pk.x, pk.y);
      g.beginPath(); g.arc(s.x, s.y, (pk.kind === 'corner' ? 0.075 : 0.065) * scale, 0, Math.PI * 2); g.fill();
    }
    if (!lastState) return;
    // aim guide
    const cue = lastState.balls[0];
    if (aimMilli != null && !cue.potted) {
      const prev = window.CCRules.aimPreview(lastState, aimMilli);
      const a = aimMilli / 1000;
      const ex = prev ? prev.x : cue.x + Math.cos(a) * 1.5;
      const ey = prev ? prev.y : cue.y + Math.sin(a) * 1.5;
      const s1 = toScreen(cue.x, cue.y), s2 = toScreen(ex, ey);
      g.strokeStyle = '#fff2b0'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(s1.x, s1.y); g.lineTo(s2.x, s2.y); g.stroke();
      if (prev && prev.ball != null) {
        g.beginPath(); g.arc(s2.x, s2.y, T.R * scale, 0, Math.PI * 2); g.stroke();
      }
    }
    for (let i = 0; i < lastState.balls.length; i++) {
      const b = lastState.balls[i];
      let x = b.x, y = b.y, vis = !b.potted;
      if (frameOverride) {
        const fx = frameOverride[i * 2], fy = frameOverride[i * 2 + 1];
        if (fx == null) vis = false; else { x = fx; y = fy; vis = true; }
      }
      if (!vis) continue;
      const s = toScreen(x, y);
      if (legalSet.has(b.n)) {
        g.strokeStyle = '#fff2b0'; g.lineWidth = 2.5;
        g.beginPath(); g.arc(s.x, s.y, T.R * scale * 1.55, 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = hex(ballColor(b.n, highContrast));
      g.beginPath(); g.arc(s.x, s.y, T.R * scale, 0, Math.PI * 2); g.fill();
      if (b.n !== 0) {
        g.fillStyle = '#f6f1e6';
        g.beginPath(); g.arc(s.x, s.y, T.R * scale * 0.58, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#181818';
        g.font = `bold ${Math.max(8, T.R * scale * 0.7)}px system-ui, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(b.n), s.x, s.y + 1);
      }
    }
    if (placeG) {
      const s = toScreen(placeG.x, placeG.y);
      g.strokeStyle = '#ffffff'; g.setLineDash([4, 3]);
      g.beginPath(); g.arc(s.x, s.y, T.R * scale, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
  }
  function loop(now) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    if (playing) {
      const p = playing;
      const fi = Math.max(0, Math.min(p.trace.frames.length - 1, Math.floor((now - p.start) / (1000 / 60))));
      frameOverride = p.trace.frames[fi];
      const tickReached = fi * p.trace.every;
      while (p.pi < p.physics.length && p.physics[p.pi].tick <= p.tick0 + tickReached) {
        if (p.cbs.onPhysicsEvent) p.cbs.onPhysicsEvent(p.physics[p.pi++]);
        else p.pi++;
      }
      draw();
      if (fi >= p.trace.frames.length - 1) {
        playing = null; frameOverride = null;
        draw();
        if (p.cbs.onDone) p.cbs.onDone();
      }
    }
  }
  raf = requestAnimationFrame(loop);
  resize();
  return {
    mode: '2d',
    setSnapshot(state) { lastState = state ? JSON.parse(JSON.stringify(state)) : null; if (!playing) { frameOverride = null; draw(); } },
    playTrace(trace, physics, cbs) {
      playing = { trace, physics: physics || [], cbs: cbs || {}, start: performance.now(), pi: 0, tick0: lastState ? lastState.tick : 0 };
    },
    skipTrace() {
      if (!playing) return;
      const p = playing; playing = null;
      frameOverride = p.trace.frames[p.trace.frames.length - 1];
      draw(); frameOverride = null;
      if (p.cbs.onDone) p.cbs.onDone();
    },
    cancelTrace() { playing = null; frameOverride = null; draw(); },
    setAim(state, a) { aimMilli = a; if (state) lastState = JSON.parse(JSON.stringify(state)); draw(); },
    setLegalTargets(nums) { legalSet = new Set(nums || []); draw(); },
    setPlacement(on) { if (!on) { placeG = null; draw(); } },
    setPlacementGhost(x, y) { placeG = x == null ? null : { x, y }; draw(); },
    tablePointFromScreen(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      // rect/client coords are visual (zoomed) px; ox/oy/scale are layout px
      const z = rect.width / (canvas.clientWidth || rect.width) || 1;
      return { x: T.MIN_X + ((cx - rect.left) / z - ox) / scale, y: T.MAX_Y - ((cy - rect.top) / z - oy) / scale };
    },
    burstAt() {},
    setTheme(t) { theme = t; draw(); },
    setGraphics() {},
    graphicsInfo() { return null; },
    setHighContrast(b) { highContrast = !!b; draw(); },
    setReducedMotion() {},
    resize,
    dispose() { disposed = true; cancelAnimationFrame(raf); if (canvas.parentNode) canvas.parentNode.removeChild(canvas); }
  };
}

export function create(host, opts) {
  opts = opts || {};
  try {
    return createThree(host, opts);
  } catch (e) {
    if (opts.onFallback) opts.onFallback(e);
    return create2D(host, opts);
  }
}

export default { create };
