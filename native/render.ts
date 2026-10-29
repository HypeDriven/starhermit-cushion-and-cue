// The cue hall on starhermit:scene, as the browser build's js/render.js drew
// it with three.js: the table (cloth tinted by the theme with the authored
// felt weave, six cushion rails, the wood surround, pockets with leather lips
// and glow rings, mother-of-pearl diamond sights), the balls with their
// numbered equirectangular skins (number disc up, stripes as a band),
// legal-target rings that breathe, soft contact shadows, the cue stick behind
// the cue ball with the aim guide line and the ghost ring where the cue ball
// meets its first ball, the placement ghost for ball in hand, pocket spark
// bursts (one instanced draw), dust motes over the rails, and the room
// around it (walls with seeded framed panels, a plank floor and a rug, a warm
// key light whose shadow is fitted to the table, a hemisphere fill and on
// Detailed a spot pool that lets the room fall into shade). The theme sets
// the colours; the graphics level sets the look (quality.ts): materials,
// geometry and texture detail, shadows, reflections (a RoomEnvironment),
// post effects (renderer.ao / bloom / grade / antialias replace the old
// EffectComposer chain), sparks and motes. Reduced motion stops the motes,
// sparks, ring breathing and camera shake. Trace playback is main.ts's (one
// 60 Hz trace frame per fixed step); this module places what it is given.
//
// The table shows in a rectangle of the window (the old canvas between the
// HUD rails): the camera's view offset puts the full image the camera would
// fill exactly there, and the camera pulls back until the whole table with
// its cushions projects inside ±0.94 of it (fitCamera), so every pocket stays
// on screen at any aspect. Picking casts the pointer onto the cloth plane.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  CylinderGeometry, DirectionalLight, DoubleSide, DynamicDrawUsage, Group, HemisphereLight, InstancedMesh, Line, LineBasicMaterial,
  Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, MirroredRepeatWrapping,
  Object3D, PMREMGenerator, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, Raycaster, RepeatWrapping, RingGeometry,
  RoomEnvironment, SRGBColorSpace, SphereGeometry, SpotLight, TextureLoader, TorusGeometry, Vector3, mergeGeometries, pointerToNdc,
  renderer, scene, type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Content, RNG, Rules, type Ball, type State, type Theme } from "./classic.ts";
import { BURST_MAX, MOTE_MAX, type Look } from "./quality.ts";

const TB = Rules.TABLE;
const PI = Math.PI;
const TABLE_TOP = 0;
const DECOR_SEED = 7;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const hexCss = (c: number): string => "#" + (c >>> 0).toString(16).padStart(6, "0");
function ballColor(n: number, hc: boolean): number {
  const d = Content.BALLS[n] ?? Content.BALLS[0]!;
  return hc ? d.colorHC : d.color;
}

const camera = new PerspectiveCamera(38, 16 / 9, 0.1, 30);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.camera = null;
const CAM = { y: 2.05, z: 1.05 };           // slightly tilted top-down framing
let camScale = 1;                           // widened by fitCamera() per aspect
camera.position.set(0, CAM.y, CAM.z);
camera.lookAt(0, 0, -0.08);

let look: Look | null = null;
let theme: Theme = Content.themeById("tournament");
let highContrast = false;
let reducedMotion = false;
let shake = 0;
let clock = 0;

// ---------------------------------------------------------------- textures
function canvasTex(w: number, h: number, paint: (g: OffscreenCanvasRenderingContext2D, w: number, h: number) => void, srgb = true): Texture {
  const c = new OffscreenCanvas(w, h);
  paint(c.getContext("2d"), w, h);
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  return t;
}
// Ball skin: equirectangular map. The number disc sits on the equator at
// u = 0.25 (and 0.75); the mesh is turned so that point faces up. Stripes
// (9–15) get a white body with a coloured band through the number.
function ballTexture(n: number, hc: boolean, size: number): Texture {
  return canvasTex(size, size / 2, (g, W, H) => {
    g.scale(W / 512, H / 256);
    const w = 512, h = 256;
    const col = hexCss(ballColor(n, hc));
    const stripe = n >= 9 && n <= 15;
    g.fillStyle = stripe || n === 0 ? (hc ? "#ffffff" : "#f6f1e6") : col;
    g.fillRect(0, 0, w, h);
    if (stripe) { g.fillStyle = col; g.fillRect(0, h * 0.5 - 66, w, 132); }
    if (n === 0) {
      g.fillStyle = hc ? "#d00000" : "#b8423a";
      for (const u of [0.25, 0.75]) { g.beginPath(); g.arc(w * u, h / 2, 7, 0, PI * 2); g.fill(); }
      return;
    }
    for (const u of [0.25, 0.75]) {
      const x = w * u, y = h / 2;
      g.fillStyle = hc ? "#ffffff" : "#f6f1e6";
      g.beginPath(); g.arc(x, y, 22, 0, PI * 2); g.fill();
      g.fillStyle = "#141414";
      g.font = `bold ${n >= 10 ? 24 : 30}px sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(n), x, y + 2);
    }
  });
}
// Light wood grain (multiplied by the theme's wood colour).
function grainTexture(): Texture {
  const rng = RNG.derive(DECOR_SEED, RNG.STREAM_DECOR);
  const tex = canvasTex(512, 64, (g, w, h) => {
    g.fillStyle = "#e8e2da"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const y = rng.next() * h, a = 0.05 + rng.next() * 0.12, amp = 1 + rng.next() * 3, f = 0.004 + rng.next() * 0.01;
      g.strokeStyle = `rgba(60,36,20,${a})`;
      g.lineWidth = 0.6 + rng.next() * 1.6;
      g.beginPath();
      for (let x = 0; x <= w; x += 8) g.lineTo(x, y + Math.sin(x * f + i) * amp);
      g.stroke();
    }
    g.fillStyle = "rgba(255,245,230,0.08)";
    for (let i = 0; i < 6; i++) g.fillRect(0, rng.next() * h, w, 2 + rng.next() * 4);
  });
  tex.wrapS = tex.wrapT = RepeatWrapping;
  return tex;
}
// Floor planks with per-board tone variation.
function plankTexture(): Texture {
  const rng = RNG.derive(DECOR_SEED + 7, RNG.STREAM_DECOR);
  const tex = canvasTex(512, 512, (g, w, h) => {
    const rows = 8, rh = h / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rng.next() * 200;
      while (x < w) {
        const len = 180 + rng.next() * 220, t = 200 + Math.floor(rng.next() * 45);
        g.fillStyle = `rgb(${t},${t - 8},${t - 18})`;
        g.fillRect(x, r * rh, len, rh);
        g.strokeStyle = "rgba(0,0,0,0.08)"; g.lineWidth = 1;
        for (let k = 0; k < 5; k++) {
          const yy = r * rh + rng.next() * rh;
          g.beginPath(); g.moveTo(x, yy); g.lineTo(x + len, yy + (rng.next() - 0.5) * 3); g.stroke();
        }
        g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(x, r * rh, 2, rh);
        x += len;
      }
      g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(0, r * rh, w, 2);
    }
  });
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}
// Rug under the table: field, border bands and lozenges in theme colours.
function rugTexture(p: Theme["palette"]): Texture {
  return canvasTex(512, 320, (g, w, h) => {
    const field = new Color(p.wall).lerp(new Color(p.accent), 0.08).multiplyScalar(0.85);
    g.fillStyle = hexCss(field.getHex()); g.fillRect(0, 0, w, h);
    g.strokeStyle = hexCss(p.accent); g.globalAlpha = 0.35;
    for (const [inset, lw] of [[10, 5], [24, 2], [34, 1]] as const) {
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
function blobTexture(): Texture {
  return canvasTex(64, 64, (g, w) => {
    const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, "rgba(0,0,0,0.9)");
    grd.addColorStop(0.45, "rgba(0,0,0,0.5)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
  }, false);
}
// Cue: tip, ferrule, maple shaft, brass joint, ebony butt (v runs butt → tip).
function cueTexture(): Texture {
  return canvasTex(4, 256, (g, w, h) => {
    const band = (a: number, b: number, c: string): void => { g.fillStyle = c; g.fillRect(0, h - b * h, w, (b - a) * h); };
    band(0, 0.36, "#2a1a12");
    band(0.36, 0.38, "#c9a45a");
    band(0.38, 0.955, "#d8b98a");
    band(0.955, 0.985, "#d9d2c4");
    band(0.985, 1, "#4a78b8");
  });
}
const texCache = new Map<string, Texture>();
const getTex = (k: string, make: () => Texture): Texture => {
  let t = texCache.get(k);
  if (!t) { t = make(); texCache.set(k, t); }
  return t;
};

// ---------------------------------------------------------------- materials
interface LitParams {
  color?: number; map?: Texture | null; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number;
  envMapIntensity?: number; transparent?: boolean; opacity?: number;
}
/** Lit material in the level's budget class: Lambert on Low, Standard on Balanced, Physical (clear-coat) on
 * High/Ultra where `physical` asks for it. Felt sheen has no counterpart on the engine (dropped). */
/** r160's scene.environment was scaled by each material's envMapIntensity; three r163+ (the engine) applies
 * scene.environmentIntensity instead, so every standard material takes the room as its own envMap. */
function envOf(): Texture | null { return look?.reflections ? ensureEnv() : null; }
function bindEnv(): void {
  const env = envOf();
  scene.traverse((o) => {
    const m = (o as Mesh).material as MeshStandardMaterial | MeshStandardMaterial[] | undefined;
    for (const x of Array.isArray(m) ? m : m ? [m] : []) if ("envMapIntensity" in x && x.envMap !== env) x.envMap = env;
  });
}
function lit(p: LitParams, physical = false): Material {
  const kind = look?.budget.material ?? "standard";
  const base = { color: p.color ?? 0xffffff, map: p.map ?? null, ...(p.transparent ? { transparent: true, opacity: p.opacity ?? 1 } : {}) };
  if (kind === "lambert") return new MeshLambertMaterial(base);
  const std = { ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0, envMapIntensity: p.envMapIntensity ?? 1, envMap: envOf() };
  if (kind === "physical" && physical) return new MeshPhysicalMaterial({ ...std, clearcoat: p.clearcoat ?? 0, clearcoatRoughness: p.clearcoatRoughness ?? 0 });
  return new MeshStandardMaterial(std);
}

// ---------------------------------------------------------------- lights
const hemi = new HemisphereLight(0xfff1dc, 0x1a1410, 0.9);
scene.add(hemi);
const key = new DirectionalLight(0xfff4e2, 1.5);
key.position.set(0.35, 3, 0.55);
scene.add(key, key.target);
{
  const sc = key.shadow.camera as unknown as { left: number; right: number; top: number; bottom: number; near: number; far: number };
  sc.left = -1.62; sc.right = 1.62; sc.top = 1.02; sc.bottom = -1.02; sc.near = 1.5; sc.far = 4.5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.004;
}
const pool = new SpotLight(0xffe2b0, 4.2, 0, 0.8, 0.8, 2);
pool.position.set(0, 2.3, 0);
scene.add(pool, pool.target);
let envTex: Texture | null = null;
function ensureEnv(): Texture | null {
  if (envTex) return envTex;
  try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
  catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
  return envTex;
}

// ---------------------------------------------------------------- room (rebuilt on theme / look)
let envGroup: Group | null = null;
function disposeGroup(gp: Object3D): void {
  for (const o of gp.children) {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material && !Array.isArray(m.material)) (m.material as Material).dispose();
  }
}
let rugTex: Texture | null = null;
function buildEnvironment(): void {
  if (envGroup) { scene.remove(envGroup); disposeGroup(envGroup); }
  if (rugTex) { rugTex.dispose(); rugTex = null; }
  envGroup = new Group();
  const p = theme.palette;
  const detailed = !!look?.detailed;
  scene.background = new Color(p.fog);
  pool.color.set(p.light);
  key.color.set(p.light).lerp(new Color(0xffffff), 0.6);

  const floorMat = lit({ color: p.floor, roughness: detailed ? 0.75 : 0.95, envMapIntensity: 0.1, map: detailed ? getTex("plank", plankTexture) : null });
  const floor = new Mesh(new PlaneGeometry(9, 7), floorMat);
  floor.rotation.x = -PI / 2; floor.position.y = -0.78;
  floor.receiveShadow = true;
  envGroup.add(floor);
  if (detailed) {
    rugTex = rugTexture(p);
    const rug = new Mesh(new PlaneGeometry(3.9, 2.5), lit({ map: rugTex, roughness: 1, envMapIntensity: 0.1 }));
    rug.rotation.x = -PI / 2; rug.position.y = -0.775;
    rug.receiveShadow = true;
    envGroup.add(rug);
  }
  const wallMat = lit({ color: p.wall, roughness: 0.9, envMapIntensity: 0.15 });
  const mkWall = (w: number, x: number, z: number, ry: number): void => {
    const wall = new Mesh(new BoxGeometry(w, 2.4, 0.1), wallMat);
    wall.position.set(x, 0.4, z); wall.rotation.y = ry;
    envGroup!.add(wall);
  };
  mkWall(9, 0, -2.6, 0); mkWall(9, 0, 2.6, 0);
  mkWall(7, -3.4, 0, PI / 2); mkWall(7, 3.4, 0, PI / 2);
  // deterministic decor: seeded frames/panels on the walls
  const decor = RNG.derive(DECOR_SEED, RNG.STREAM_DECOR);
  for (let i = 0; i < 6; i++) {
    const m = new Mesh(new BoxGeometry(0.5, 0.36, 0.03), lit({ color: decor.next() < 0.5 ? p.accent : p.metal, roughness: 0.6, metalness: 0.3 }));
    const side = decor.int(2) ? -2.53 : 2.53;
    m.position.set(-3 + decor.next() * 6, 0.55 + decor.next() * 0.5, side);
    envGroup.add(m);
  }
  scene.add(envGroup);
}

// ---------------------------------------------------------------- table
const tableGroup = new Group();
scene.add(tableGroup);
let tableParts: Object3D[] = [];
// Authored felt weave (assets/cloth.webp), tinted by the theme's cloth colour;
// flat colour while it loads or if it fails.
let clothTex: Texture | null = null;
let clothMats: Material[] = [];
try {
  new TextureLoader().load("assets/cloth.webp", (t) => {
    t.wrapS = t.wrapT = MirroredRepeatWrapping;
    t.repeat.set(8, 4);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    clothTex = t;
    for (const m of clothMats) m.map = t;
  }, (e: unknown) => console.warn(`cloth: ${e instanceof Error ? e.message : String(e)}`));
} catch (e) { console.warn(`cloth: ${String(e)}`); }
function feltMaterial(color: number, detailed: boolean): Material {
  const m = detailed ? lit({ color, roughness: 0.9, envMapIntensity: 0.12, map: clothTex }, true) : lit({ color, roughness: 0.92, map: clothTex });
  clothMats.push(m);
  return m;
}
interface PocketView { pocket: { x: number; y: number }; glow: Mesh }
let pocketViews: PocketView[] = [];
/** Meshes that share one material merged into one (world transforms baked in). */
function mergeMeshes(meshes: Mesh[]): Mesh | null {
  const parts = meshes.map((m) => {
    m.updateMatrix();
    const g = m.geometry.toNonIndexed();
    g.applyMatrix4(m.matrix);
    return g;
  });
  const out = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  if (!out) return null;
  const mesh = new Mesh(out, meshes[0]!.material as Material);
  mesh.castShadow = meshes[0]!.castShadow; mesh.receiveShadow = meshes[0]!.receiveShadow;
  return mesh;
}
function buildTable(): void {
  for (const o of tableParts) {
    tableGroup.remove(o);
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (m.material as Material).dispose();
  }
  tableParts = [];
  clothMats = [];
  const p = theme.palette;
  const detailed = !!look?.detailed;
  const casts = (look?.shadows ?? 0) > 0;
  const add = <T extends Object3D>(o: T): T => { tableGroup.add(o); tableParts.push(o); return o; };
  const merge: Record<string, Mesh[]> = { rails: [], woodX: [], woodZ: [], pockets: [] };

  const cloth = new Mesh(new BoxGeometry(TB.PLAY_W + 0.24, 0.06, TB.PLAY_H + 0.24), feltMaterial(p.cloth, detailed));
  cloth.position.y = TABLE_TOP - 0.03;
  cloth.receiveShadow = true;
  add(cloth);
  // cushions: 6 rail segments
  const railH = 0.055, railW = 0.09;
  const railMat = feltMaterial(p.cushion, detailed);
  const mkRail = (w: number, d: number, x: number, z: number): void => {
    const r = new Mesh(new BoxGeometry(w, railH, d), railMat);
    r.position.set(x, TABLE_TOP + railH / 2, z); r.castShadow = casts; r.receiveShadow = true;
    merge.rails!.push(add(r));
  };
  const hx = TB.PLAY_W / 2, hz = TB.PLAY_H / 2;
  mkRail(TB.PLAY_W / 2 - 0.12, railW, -(TB.PLAY_W / 4 + 0.03), -hz - railW / 2);
  mkRail(TB.PLAY_W / 2 - 0.12, railW, TB.PLAY_W / 4 + 0.03, -hz - railW / 2);
  mkRail(TB.PLAY_W / 2 - 0.12, railW, -(TB.PLAY_W / 4 + 0.03), hz + railW / 2);
  mkRail(TB.PLAY_W / 2 - 0.12, railW, TB.PLAY_W / 4 + 0.03, hz + railW / 2);
  mkRail(railW, TB.PLAY_H + 0.1, -hx - railW / 2, 0);
  mkRail(railW, TB.PLAY_H + 0.1, hx + railW / 2, 0);
  // wood surround: lacquered grain on Detailed
  const woodH = 0.16, ext = 0.2;
  const woodMat = (alongZ: boolean): Material => {
    if (!detailed) return lit({ color: p.wood, roughness: 0.6 });
    const grain = getTex(alongZ ? "grainZ" : "grainX", () => {
      const t = grainTexture();
      if (alongZ) { t.center.set(0.5, 0.5); t.rotation = PI / 2; }
      return t;
    });
    return lit({ color: p.wood, map: grain, roughness: 0.55, clearcoat: 0.5, clearcoatRoughness: 0.35, envMapIntensity: 0.25 }, true);
  };
  const woodX = woodMat(false), woodZ = woodMat(true);
  const mkWood = (w: number, d: number, x: number, z: number, alongZ: boolean): void => {
    const m = new Mesh(new BoxGeometry(w, woodH, d), alongZ ? woodZ : woodX);
    m.position.set(x, TABLE_TOP - woodH / 2 + 0.09, z); m.castShadow = casts; m.receiveShadow = true;
    (alongZ ? merge.woodZ! : merge.woodX!).push(add(m));
  };
  mkWood(TB.PLAY_W + ext * 2 + 0.2, ext, 0, -hz - railW - ext / 2, false);
  mkWood(TB.PLAY_W + ext * 2 + 0.2, ext, 0, hz + railW + ext / 2, false);
  mkWood(ext, TB.PLAY_H + 0.2, -hx - railW - ext / 2, 0, true);
  mkWood(ext, TB.PLAY_H + 0.2, hx + railW + ext / 2, 0, true);
  if (detailed) {
    // mother-of-pearl diamond sights inlaid in the rails (one instanced draw)
    const sightMat = lit({ color: 0xbfb49c, roughness: 0.5, envMapIntensity: 0.3 });
    const yTop = TABLE_TOP + 0.0905;
    const zRail = hz + railW + ext / 2, xRail = hx + railW + ext / 2;
    const sights: [number, number][] = [];
    for (let k = 1; k <= 7; k++) if (k !== 4) { const x = -hx + (k * TB.PLAY_W) / 8; sights.push([x, -zRail], [x, zRail]); }
    for (let k = 1; k <= 3; k++) { const z = -hz + (k * TB.PLAY_H) / 4; sights.push([-xRail, z], [xRail, z]); }
    const inst = new InstancedMesh(new CircleGeometry(0.011, 4), sightMat, sights.length);
    const o = new Object3D();
    sights.forEach(([x, z], i) => {
      o.rotation.set(-PI / 2, 0, PI / 4);
      o.position.set(x, yTop, z);
      o.updateMatrix();
      inst.setMatrixAt(i, o.matrix);
    });
    add(inst);
  }
  // pockets: dark cylinders slightly below cloth (+ a leather lip on Detailed)
  pocketViews = [];
  const pocketMat = lit({ color: 0x070708, roughness: 1 });
  for (const pk of TB.POCKETS) {
    const r = pk.kind === "corner" ? 0.075 : 0.065;
    const m = new Mesh(new CylinderGeometry(r, r * 0.8, 0.12, 24), pocketMat);
    m.position.set(pk.x, TABLE_TOP - 0.055, -pk.y);
    merge.pockets!.push(add(m));
    if (detailed) {
      const lip = new Mesh(new TorusGeometry(r, 0.006, 8, 28), lit({ color: 0x1b120c, roughness: 0.45, clearcoat: 0.6, envMapIntensity: 0.6 }, true));
      lip.rotation.x = -PI / 2;
      lip.position.set(pk.x, TABLE_TOP + 0.002, -pk.y);
      add(lip);
    }
    const glow = new Mesh(new RingGeometry(r + 0.005, r + 0.03, 24),
      new MeshBasicMaterial({ color: p.accent, transparent: true, opacity: 0, side: DoubleSide, toneMapped: false }));
    glow.rotation.x = -PI / 2;
    glow.position.set(pk.x, TABLE_TOP + 0.003, -pk.y);
    glow.visible = false;
    glow.noAO = true;
    add(glow);
    pocketViews.push({ pocket: pk, glow });
  }
  if (look?.budget.mergeTable) {
    for (const list of Object.values(merge)) {
      if (list.length < 2) continue;
      const one = mergeMeshes(list);
      if (!one) continue;
      add(one);
      for (const o of list) {
        tableGroup.remove(o); o.geometry.dispose();
        tableParts.splice(tableParts.indexOf(o), 1);
      }
    }
  }
}

// ---------------------------------------------------------------- balls
const ballGroup = new Group();
scene.add(ballGroup);
const ballGeos = new Map<number, BufferGeometry>();
const ballGeo = (segs: number): BufferGeometry => {
  let g = ballGeos.get(segs);
  if (!g) { g = new SphereGeometry(TB.R, segs, Math.round(segs * 0.7)); ballGeos.set(segs, g); }
  return g;
};
const blobGeo = new PlaneGeometry(TB.R * 3.4, TB.R * 3.4);
const ringGeo = new RingGeometry(TB.R * 1.25, TB.R * 1.6, 24);
interface BallView { mesh: Mesh; ring: Mesh; ringMat: MeshBasicMaterial; blob: Mesh | null }
let ballViews = new Map<number, BallView>();
let legal = new Set<number>();
const ballTex = new Map<string, Texture>();
function getBallTex(n: number): Texture {
  const size = look?.budget.ballTex ?? 512;
  const k = `${n}${highContrast ? "hc" : ""}-${size}`;
  let t = ballTex.get(k);
  if (!t) { t = ballTexture(n, highContrast, size); t.anisotropy = 4; ballTex.set(k, t); }
  return t;
}
function placeBall(v: BallView, x: number, y: number, visible: boolean): void {
  v.mesh.visible = visible;
  if (!visible) v.ring.visible = false;
  if (v.blob) v.blob.visible = visible;
  if (!visible) return;
  v.mesh.position.set(x, TABLE_TOP + TB.R, -y);
  v.ring.position.set(x, TABLE_TOP + 0.002, -y);
  if (v.blob) v.blob.position.set(x + 0.004, TABLE_TOP + 0.0015, -y + 0.004);
}
let lastState: State | null = null;
function rebuildBalls(state: State | null): void {
  for (const v of ballViews.values()) {
    ballGroup.remove(v.mesh, v.ring);
    (v.mesh.material as Material).dispose(); v.ringMat.dispose();
    if (v.blob) { ballGroup.remove(v.blob); (v.blob.material as Material).dispose(); }
  }
  ballViews = new Map();
  if (!state) return;
  const detailed = !!look?.detailed;
  const shadows = (look?.shadows ?? 0) > 0;
  for (const b of state.balls) {
    const map = getBallTex(b.n);
    const mat = detailed
      ? lit({ map, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.5 }, true)
      : lit({ map, roughness: 0.25, metalness: 0.05 });
    const segs = detailed ? look!.budget.ballSegs : Math.min(24, look?.budget.ballSegs ?? 24);
    const mesh = new Mesh(ballGeo(segs), mat);
    mesh.rotation.x = -PI / 2;   // number disc faces up
    mesh.castShadow = shadows;
    // selection ring (grounded marker for legal targets)
    const ringMat = new MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0, side: DoubleSide, toneMapped: false });
    const ring = new Mesh(ringGeo, ringMat);
    ring.rotation.x = -PI / 2;
    ring.noAO = true;
    let blob: Mesh | null = null;
    if (detailed) {
      blob = new Mesh(blobGeo, new MeshBasicMaterial({ map: getTex("blob", blobTexture), transparent: true, depthWrite: false, opacity: shadows ? 0.45 : 0.7 }));
      blob.rotation.x = -PI / 2;
      blob.noAO = true;
      ballGroup.add(blob);
    }
    ballGroup.add(ring, mesh);
    const v: BallView = { mesh, ring, ringMat, blob };
    ballViews.set(b.n, v);
    placeBall(v, b.x, b.y, !b.potted);
  }
}

// ---------------------------------------------------------------- cue, guide, ghosts
const cueStick = new Mesh<Material>(new CylinderGeometry(0.006, 0.011, 1.1, 16), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
cueStick.visible = false;
cueStick.rotation.order = "YXZ";
scene.add(cueStick);
const aimPos = new Float32Array(6);
const aimGeo = new BufferGeometry();
aimGeo.setAttribute("position", new BufferAttribute(aimPos, 3));
const aimLine = new Line(aimGeo, new LineBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.9, toneMapped: false }));
aimLine.visible = false;
aimLine.frustumCulled = false;
scene.add(aimLine);
const ghost = new Mesh(new RingGeometry(TB.R * 0.8, TB.R, 24), new MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.7, side: DoubleSide, toneMapped: false }));
ghost.rotation.x = -PI / 2;
ghost.visible = false;
ghost.noAO = true;
scene.add(ghost);
const placeGhost = new Mesh(new SphereGeometry(TB.R, 24, 18), new MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
placeGhost.visible = false;
scene.add(placeGhost);
function cueMaterial(): Material {
  return lit({ color: 0xffffff, map: getTex("cue", cueTexture), roughness: 0.5, clearcoat: 0.4, envMapIntensity: 0.3 }, true);
}

// ---------------------------------------------------------------- particles
// One instanced draw for every spark; the pool in use is the level's burst
// budget; a spark fades by shrinking (instances share one material).
interface Spark { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number }
const sparks: Spark[] = [];
const sparkMesh = new InstancedMesh(new SphereGeometry(0.008, 6, 5), new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), BURST_MAX);
sparkMesh.instanceMatrix.setUsage(DynamicDrawUsage);
sparkMesh.frustumCulled = false;
sparkMesh.noAO = true;
sparkMesh.count = 0;
scene.add(sparkMesh);
const sparkColor = new Color(), sparkM = new Matrix4();
for (let i = 0; i < BURST_MAX; i++) {
  sparks.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0 });
  sparkMesh.setColorAt(i, sparkColor.set(0xfff2b0));
}
let sparkNext = 0;
const motionOff = (): boolean => reducedMotion;
function burst(x: number, z: number, color: number, count: number): void {
  if (!look || motionOff() || look.particles === "off") return;
  const poolN = Math.min(BURST_MAX, look.budget.burst);
  const n = Math.min(poolN, look.particles === "high" ? count : Math.ceil(count / 2));
  for (let i = 0; i < n; i++) {
    const idx = sparkNext++ % poolN;
    const p = sparks[idx]!;
    const a = Math.random() * PI * 2, sp = 0.3 + Math.random() * 0.7;
    p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = 0.8 + Math.random() * 0.8;
    p.life = 0.5;
    p.x = x; p.y = TABLE_TOP + TB.R; p.z = z;
    sparkMesh.setColorAt(idx, sparkColor.set(color));
  }
  if (sparkMesh.instanceColor) sparkMesh.instanceColor.needsUpdate = true;
}
// Dust motes drifting in the lamp light, over the rails and the room, never over the cloth.
const motePos = new Float32Array(MOTE_MAX * 3), moteSeed = new Float32Array(MOTE_MAX);
{
  const r = RNG.derive(DECOR_SEED + 3, RNG.STREAM_AV);
  for (let i = 0; i < MOTE_MAX; i++) {
    let x: number, z: number;
    do { x = (r.next() - 0.5) * 3.8; z = (r.next() - 0.5) * 2.4; } while (Math.abs(x) < 1.45 && Math.abs(z) < 0.85);
    motePos[i * 3] = x;
    motePos[i * 3 + 1] = 0.1 + r.next() * 0.5;
    motePos[i * 3 + 2] = z;
    moteSeed[i] = r.next() * 100;
  }
}
const moteGeo = new BufferGeometry();
const moteAttr = new BufferAttribute(motePos, 3);
moteAttr.setUsage(DynamicDrawUsage);
moteGeo.setAttribute("position", moteAttr);
const motes = new Points(moteGeo, new PointsMaterial({ color: 0xffe6c0, size: 0.006, transparent: true, opacity: 0.22, depthWrite: false, blending: AdditiveBlending }));
motes.visible = false;
motes.frustumCulled = false;
motes.noAO = true;
scene.add(motes);
function updateMotes(dt: number): void {
  const on = !!look && look.particles !== "off" && !motionOff();
  motes.visible = on;
  if (!on || !look) return;
  moteGeo.setDrawRange(0, Math.min(MOTE_MAX, look.particles === "high" ? look.budget.motes : Math.min(20, look.budget.motes)));
  for (let i = 0; i < MOTE_MAX; i++) {
    const s = moteSeed[i]!;
    motePos[i * 3] = motePos[i * 3]! + Math.sin(clock * 0.3 + s) * 0.004 * dt;
    motePos[i * 3 + 1] = motePos[i * 3 + 1]! + (0.008 + Math.sin(clock * 0.21 + s * 1.7) * 0.006) * dt;
    motePos[i * 3 + 2] = motePos[i * 3 + 2]! + Math.cos(clock * 0.25 + s) * 0.004 * dt;
    if (motePos[i * 3 + 1]! > 0.7) motePos[i * 3 + 1] = 0.1;
  }
  moteAttr.needsUpdate = true;
}

// ---------------------------------------------------------------- the look and theme
function applyGraphics(): void {
  if (!look) return;
  const shadows = look.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  key.castShadow = shadows;
  if (shadows) key.shadow.mapSize = look.shadows;
  scene.environment = null; // per-material envMaps (bindEnv)
  bindEnv();
  pool.visible = look.detailed;
  hemi.intensity = look.detailed ? 0.4 : 1.0;
  key.intensity = look.detailed ? 1.0 : 1.6;
  renderer.ao = look.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.12, distanceExponent: 1.4, thickness: 0.06, scale: 1.0, samples: look.ao === "high" ? 16 : 8, resolution: look.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: look.ao === "high" ? 6 : 4, rings: 2, samples: look.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only specular glints and bright highlights bloom.
  renderer.bloom = look.bloom ? { strength: 0.28, radius: 0.35, threshold: 0.92, resolution: look.budget.bloomRes } : null;
  // The browser build's grade pass: a gentle S-curve, +10 % saturation, warm highlights / cool shadows, the 0.3 vignette.
  renderer.grade = look.grade ? {
    space: "display", contrast: 0.22, saturation: 1.1,
    shadows: [0.97, 0.98, 1.04], highlights: [1.04, 1.0, 0.95], split: [0.15, 0.8],
    vignette: { amount: 0.3, inner: 0.32, outer: 0.8 },
  } : null;
  renderer.antialias = look.antialias;
  cueStick.material = cueMaterial();
  buildEnvironment();
  buildTable();
  const s = lastState;
  lastState = null;
  setSnapshot(s);
  bindEnv();
}
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  applyGraphics();
}
/** A content theme (cloth, cushions, wood, walls, floor, light, accent, fog). */
export function setTheme(t: Theme): void {
  if (theme.id === t.id) return;
  theme = t;
  if (!look) return;
  buildEnvironment();
  buildTable();
}
export function setHighContrast(on: boolean): void {
  if (highContrast === on) return;
  highContrast = on;
  const s = lastState;
  lastState = null;
  setSnapshot(s);
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; if (on) shake = 0; }

// ---------------------------------------------------------------- state → table
/** The rules state's balls (a rebuild when the set of balls changed). */
export function setSnapshot(state: State | null): void {
  const prev = lastState;
  const rebuild = !prev || !state || prev.balls.length !== state.balls.length || state.balls.some((b, i) => prev.balls[i]!.n !== b.n);
  if (rebuild) rebuildBalls(state);
  lastState = state ? Rules.clone(state) : null;
  if (state) for (const b of state.balls) { const v = ballViews.get(b.n); if (v) placeBall(v, b.x, b.y, !b.potted); }
}
/** One trace frame: [x0, y0, x1, y1, …] in the state's ball order, null for a potted ball. */
export function applyFrame(frame: readonly (number | null)[] | undefined): void {
  if (!lastState || !frame) return;
  lastState.balls.forEach((b: Ball, i: number) => {
    const v = ballViews.get(b.n);
    if (!v) return;
    const x = frame[i * 2], y = frame[i * 2 + 1];
    if (x == null || y == null) placeBall(v, 0, 0, false);
    else placeBall(v, x, y, true);
  });
}
/** The pocket spark burst (a pocket event during playback). */
export function pocketBurst(pocket: number): void {
  const pk = TB.POCKETS[pocket];
  if (pk) burst(pk.x, -pk.y, 0xffe9a0, 14);
}
export function setLegalTargets(nums: readonly number[]): void { legal = new Set(nums); }
/** The aim guide, ghost ring, cue stick and pocket glow for an aim (null hides them). */
export function setAim(state: State | null, angleMilli: number | null): void {
  const cue = state?.balls[0];
  if (!state || angleMilli == null || !cue || cue.potted) {
    aimLine.visible = false; ghost.visible = false; cueStick.visible = false;
    for (const pv of pocketViews) pv.glow.visible = false;
    return;
  }
  const a = angleMilli / 1000;
  const dx = Math.cos(a), dy = Math.sin(a);
  const prev = Rules.aimPreview(state, angleMilli);
  const ex = prev ? prev.x : cue.x + dx * 1.5;
  const ey = prev ? prev.y : cue.y + dy * 1.5;
  aimPos.set([cue.x, TABLE_TOP + TB.R, -cue.y, ex, TABLE_TOP + TB.R, -ey]);
  (aimGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
  aimLine.visible = true;
  if (prev && prev.ball != null) {
    ghost.position.set(prev.x, TABLE_TOP + 0.003, -prev.y);
    ghost.visible = true;
  } else ghost.visible = false;
  // cue stick behind the cue ball, opposite the aim direction
  cueStick.rotation.set(0.06, a, PI / 2);
  cueStick.position.set(cue.x - dx * 0.62, TABLE_TOP + TB.R + 0.05, -cue.y + dy * 0.62);
  cueStick.visible = true;
  // pocket glow near the aim end point
  for (const pv of pocketViews) {
    const ddx = pv.pocket.x - ex, ddy = pv.pocket.y - ey;
    const on = ddx * ddx + ddy * ddy < 0.16;
    (pv.glow.material as MeshBasicMaterial).opacity = on ? 0.85 : 0;
    pv.glow.visible = on;
  }
}
/** The ghost cue ball for ball in hand (null hides it). */
export function setPlacementGhost(x: number | null, y = 0): void {
  if (x == null) { placeGhost.visible = false; return; }
  placeGhost.visible = true;
  placeGhost.position.set(x, TABLE_TOP + TB.R, -y);
}

// ---------------------------------------------------------------- camera, view, picking
let view: { x: number; y: number; w: number; h: number } | null = null;
let windowSize = { w: 0, h: 0 };
/** Where the table shows (window pixels), or null: no table (the menus) and no 3D drawing. */
export function setView(rect: { x: number; y: number; w: number; h: number } | null, winW: number, winH: number): void {
  if (!rect || rect.w < 2 || rect.h < 2) {
    view = null;
    renderer.camera = null;
    return;
  }
  renderer.camera = camera;
  const same = view && view.x === rect.x && view.y === rect.y && view.w === rect.w && view.h === rect.h && windowSize.w === winW && windowSize.h === winH;
  if (same) return;
  view = { ...rect };
  windowSize = { w: winW, h: winH };
  fitCamera(rect.w / rect.h);
  camera.aspect = rect.w / rect.h;
  camera.updateProjectionMatrix();
  camera.setViewOffset(rect.w, rect.h, -rect.x, -rect.y, winW, winH);
}
// Pull the camera back until the whole table (cushions included) is inside
// ±0.94 of the view: a fixed height cropped the ends of the table on square
// and portrait views, hiding balls and four of the six pockets. Projected by
// hand for the view's aspect (the window's differs while the offset is set).
function fitCamera(aspect: number): void {
  const wx = TB.PLAY_W / 2 + 0.13, wz = TB.PLAY_H / 2 + 0.13;
  const corners: [number, number][] = [[-wx, -wz], [wx, -wz], [-wx, wz], [wx, wz]];
  const tanH = Math.tan((camera.fov * PI) / 360);
  for (let i = 0; i < 10; i++) {
    const py = CAM.y * camScale, pz = CAM.z * camScale;
    // forward f (to the look-at point), right r = f × up, up u = r × f
    let fx = 0, fy = -py, fz = -0.08 - pz;
    const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
    let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz); rx /= rl; rz /= rl;
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    let m = 0;
    for (const [x, z] of corners) {
      const dx = x, dy = TABLE_TOP - py, dz = z - pz;
      const vz = dx * fx + dy * fy + dz * fz;
      const vx = dx * rx + dz * rz, vy = dx * ux + dy * uy + dz * uz;
      m = Math.max(m, Math.abs(vx / (vz * tanH * aspect)), Math.abs(vy / (vz * tanH)));
    }
    if (Math.abs(m - 0.94) < 0.01) break;
    camScale = clamp(camScale * (m / 0.94), 0.5, 6);
  }
  camera.position.set(0, CAM.y * camScale, CAM.z * camScale);
  camera.lookAt(0, 0, -0.08);
}
const raycaster = new Raycaster();
/** A window pixel onto the cloth plane, in table metres (y up the screen), or null. */
export function tablePoint(winX: number, winY: number): { x: number; y: number } | null {
  if (!view) return null;
  raycaster.setFromCamera(pointerToNdc(winX, winY), camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  if (Math.abs(d.y) < 1e-6) return null;
  const t = (TABLE_TOP - o.y) / d.y;
  if (t <= 0) return null;
  const hit = new Vector3(o.x + d.x * t, TABLE_TOP, o.z + d.z * t);
  return { x: hit.x, y: -hit.z };
}
/** A big event's camera shake (never under reduced motion). */
export function shakeCamera(): void { if (!motionOff()) shake = 1; }

/** Each frame: sparks, motes, the breathing target rings and the camera shake. */
export function update(dtIn: number): void {
  const dt = Math.min(0.05, Math.max(0, dtIn));
  clock += dt;
  let live = 0;
  const poolN = Math.min(BURST_MAX, look?.budget.burst ?? 16);
  for (let i = 0; i < poolN; i++) {
    const p = sparks[i]!;
    if (p.life > 0) {
      p.life -= dt;
      p.vy -= 4 * dt;
      p.x += p.vx * dt;
      p.y = Math.max(TABLE_TOP + 0.004, p.y + p.vy * dt);
      p.z += p.vz * dt;
    }
    const k = p.life > 0 ? Math.min(1, p.life * 2) : 0;
    sparkM.makeScale(k, k, k).setPosition(p.x, p.y, p.z);
    sparkMesh.setMatrixAt(i, sparkM);
    if (p.life > 0) live = i + 1;
  }
  sparkMesh.count = live;
  sparkMesh.instanceMatrix.needsUpdate = true;
  updateMotes(dt);
  // legal-target rings breathe gently (steady under reduced motion)
  const pulse = motionOff() ? 0.85 : 0.72 + 0.16 * Math.sin(clock * 3.2);
  for (const [n, v] of ballViews) {
    const on = legal.has(n) && v.mesh.visible;
    v.ringMat.opacity = on ? pulse : 0;
    v.ring.visible = on;
  }
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
}
/** The tick of the state the table shows (a shot's trace starts there). */
export function lastTick(): number { return lastState ? lastState.tick : 0; }
