/* Cushion & Cue — renderer (ES module).
 * Three.js top-down cue-hall scene when WebGL is available; a 2D canvas
 * top-down fallback otherwise so the game stays playable. Deterministic
 * decor via CCRNG STREAM_DECOR. Trace playback replays physics frames at
 * 60 Hz cosmetically; skipTrace()/completion always snaps to the exact
 * final frame, which matches the authoritative state.
 *
 * API: Render.create(host, opts) → {
 *   mode, setSnapshot(state), playTrace(trace, physics, {onPhysicsEvent,onDone}),
 *   skipTrace(), setAim(state, angleMilli|null), setLegalTargets(nums),
 *   setPlacement(on), setPlacementGhost(x,y|null), tablePointFromScreen(cx,cy),
 *   setTheme(theme), setQuality(q), setHighContrast(b), setReducedMotion(b),
 *   resize(), dispose()
 * }
 */
import * as THREE from 'three';

const T = window.CCRules.TABLE;
const BALLS = window.CCContent.BALLS;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function ballColor(n, hc) {
  const d = BALLS[n] || BALLS[0];
  return hc ? d.colorHC : d.color;
}

// ---------------------------------------------------------------- 3D -------
function createThree(host, opts) {
  const renderer = new THREE.WebGLRenderer({ antialias: opts.quality !== 'low', alpha: false });
  renderer.shadowMap.enabled = opts.quality === 'high';
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 30);
  const CAM = { y: 2.05, z: 1.05 };           // slightly tilted top-down framing
  camera.position.set(0, CAM.y, CAM.z);
  camera.lookAt(0, 0, -0.08);

  let theme = opts.theme;
  let quality = opts.quality || 'high';
  let highContrast = !!opts.highContrast;
  let reducedMotion = !!opts.reducedMotion;
  let disposed = false;
  let shake = 0;
  let raf = 0;

  const disposables = [];
  function track(o) { disposables.push(o); return o; }

  // ---- lights ----
  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(0.8, 3, 0.6);
  key.castShadow = quality === 'high';
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);

  // ---- environment group (rebuilt on theme change) ----
  let envGroup = null;
  function buildEnvironment() {
    if (envGroup) {
      scene.remove(envGroup);
      envGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    envGroup = new THREE.Group();
    const p = theme.palette;
    scene.background = new THREE.Color(p.fog);

    const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(9, 7)),
      track(new THREE.MeshStandardMaterial({ color: p.floor, roughness: 0.95 })));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.78;
    floor.receiveShadow = true;
    envGroup.add(floor);

    const wallMat = track(new THREE.MeshStandardMaterial({ color: p.wall, roughness: 0.9 }));
    const mkWall = (w, x, z, ry) => {
      const wall = new THREE.Mesh(track(new THREE.BoxGeometry(w, 2.4, 0.1)), wallMat);
      wall.position.set(x, 0.4, z); wall.rotation.y = ry;
      envGroup.add(wall);
    };
    mkWall(9, 0, -2.6, 0); mkWall(9, 0, 2.6, 0);
    mkWall(7, -3.4, 0, Math.PI / 2); mkWall(7, 3.4, 0, Math.PI / 2);

    // deterministic decor: seeded frames/panels on the walls
    const decor = window.CCRNG.derive(opts.decorSeed || 1, window.CCRNG.STREAM_DECOR);
    const frameGeo = track(new THREE.BoxGeometry(0.5, 0.36, 0.03));
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(frameGeo, track(new THREE.MeshStandardMaterial({
        color: decor.next() < 0.5 ? p.accent : p.metal, roughness: 0.6, metalness: 0.3
      })));
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
  function buildTable() {
    for (const o of tableParts) {
      tableGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
    tableParts = [];
    const p = theme.palette;
    const add = mesh => { tableGroup.add(mesh); tableParts.push(mesh); return mesh; };

    const cloth = new THREE.Mesh(new THREE.BoxGeometry(T.PLAY_W + 0.24, 0.06, T.PLAY_H + 0.24),
      new THREE.MeshStandardMaterial({ color: p.cloth, roughness: 0.92 }));
    cloth.position.y = TABLE_TOP - 0.03;
    cloth.receiveShadow = true;
    add(cloth);

    // cushions: 6 rail segments (gaps at pockets are cosmetic here)
    const cMat = new THREE.MeshStandardMaterial({ color: p.cushion, roughness: 0.85 });
    const railH = 0.055, railW = 0.09;
    const mkRail = (w, d, x, z) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, railH, d), cMat.clone());
      r.position.set(x, TABLE_TOP + railH / 2, z); r.castShadow = quality !== 'low';
      add(r);
    };
    const hx = T.PLAY_W / 2, hz = T.PLAY_H / 2;
    mkRail(T.PLAY_W / 2 - 0.12, railW, -(T.PLAY_W / 4 + 0.03), -hz - railW / 2);
    mkRail(T.PLAY_W / 2 - 0.12, railW, (T.PLAY_W / 4 + 0.03), -hz - railW / 2);
    mkRail(T.PLAY_W / 2 - 0.12, railW, -(T.PLAY_W / 4 + 0.03), hz + railW / 2);
    mkRail(T.PLAY_W / 2 - 0.12, railW, (T.PLAY_W / 4 + 0.03), hz + railW / 2);
    mkRail(railW, T.PLAY_H + 0.1, -hx - railW / 2, 0);
    mkRail(railW, T.PLAY_H + 0.1, hx + railW / 2, 0);

    // wood surround
    const wMat = new THREE.MeshStandardMaterial({ color: p.wood, roughness: 0.6 });
    const woodH = 0.16, ext = 0.2;
    const mkWood = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, woodH, d), wMat.clone());
      m.position.set(x, TABLE_TOP - woodH / 2 + 0.09, z); m.castShadow = quality === 'high';
      add(m);
    };
    mkWood(T.PLAY_W + ext * 2 + 0.2, ext, 0, -hz - railW - ext / 2);
    mkWood(T.PLAY_W + ext * 2 + 0.2, ext, 0, hz + railW + ext / 2);
    mkWood(ext, T.PLAY_H + 0.2, -hx - railW - ext / 2, 0);
    mkWood(ext, T.PLAY_H + 0.2, hx + railW + ext / 2, 0);

    // pockets: dark cylinders slightly below cloth
    const pkMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 1 });
    pocketMeshes = [];
    for (const pk of T.POCKETS) {
      const r = pk.kind === 'corner' ? 0.075 : 0.065;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.8, 0.12, 20), pkMat);
      m.position.set(pk.x, TABLE_TOP - 0.055, -pk.y);
      add(m);
      const glow = new THREE.Mesh(new THREE.RingGeometry(r + 0.005, r + 0.03, 24),
        new THREE.MeshBasicMaterial({ color: p.accent, transparent: true, opacity: 0, side: THREE.DoubleSide }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(pk.x, TABLE_TOP + 0.002, -pk.y);
      add(glow);
      pocketMeshes.push({ pocket: pk, glow });
    }
  }
  let pocketMeshes = [];

  // ---- balls ----
  const ballGroup = new THREE.Group();
  scene.add(ballGroup);
  const ballGeo = track(new THREE.SphereGeometry(T.R, 24, 18));
  let ballViews = {};     // n -> {mesh, decal}
  const decalGeo = track(new THREE.CircleGeometry(T.R * 0.62, 20));

  function numberTexture(n) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#f6f1e6';
    g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#181818';
    g.font = 'bold 30px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), 32, 34);
    const tex = new THREE.CanvasTexture(c);
    track(tex);
    return tex;
  }
  const decalTex = {};
  function getDecalTex(n) { return decalTex[n] || (decalTex[n] = numberTexture(n)); }

  function rebuildBalls(state) {
    for (const n in ballViews) {
      ballGroup.remove(ballViews[n].mesh);
      ballViews[n].mesh.material.dispose();
      if (ballViews[n].decal) { ballViews[n].mesh.remove(ballViews[n].decal); ballViews[n].decal.material.dispose(); }
    }
    ballViews = {};
    if (!state) return;
    for (const b of state.balls) {
      const mat = new THREE.MeshStandardMaterial({
        color: ballColor(b.n, highContrast), roughness: 0.25, metalness: 0.05
      });
      const mesh = new THREE.Mesh(ballGeo, mat);
      mesh.castShadow = quality !== 'low';
      mesh.position.set(b.x, TABLE_TOP + T.R, -b.y);
      if (b.n !== 0) {
        const decal = new THREE.Mesh(decalGeo,
          new THREE.MeshBasicMaterial({ map: getDecalTex(b.n), transparent: true }));
        decal.rotation.x = -Math.PI / 2;
        decal.position.y = T.R * 0.72;
        mesh.add(decal);
      }
      // selection ring (grounded marker for legal targets)
      const ring = new THREE.Mesh(new THREE.RingGeometry(T.R * 1.25, T.R * 1.6, 24),
        new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(b.x, TABLE_TOP + 0.002, -b.y);
      ballGroup.add(ring);
      ballGroup.add(mesh);
      ballViews[b.n] = { mesh, ring, decal: mesh.children[0] || null };
    }
  }

  // ---- cue stick + aim guide ----
  const cueStick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.011, 1.1, 10),
    track(new THREE.MeshStandardMaterial({ color: 0xb58548, roughness: 0.5 })));
  cueStick.visible = false;
  scene.add(cueStick);

  const aimMat = track(new THREE.LineBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.9 }));
  const aimGeo = track(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]));
  const aimLine = new THREE.Line(aimGeo, aimMat);
  aimLine.visible = false;
  scene.add(aimLine);
  const ghost = new THREE.Mesh(track(new THREE.RingGeometry(T.R * 0.8, T.R, 24)),
    track(new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.7, side: THREE.DoubleSide })));
  ghost.rotation.x = -Math.PI / 2;
  ghost.visible = false;
  scene.add(ghost);

  // placement ghost cue ball
  const placeGhost = new THREE.Mesh(ballGeo,
    track(new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 })));
  placeGhost.visible = false;
  scene.add(placeGhost);

  // ---- particles (pooled) ----
  const POOL = 48;
  const particles = [];
  const pGeo = track(new THREE.SphereGeometry(0.008, 6, 5));
  for (let i = 0; i < POOL; i++) {
    const m = new THREE.Mesh(pGeo, track(new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true })));
    m.visible = false;
    scene.add(m);
    particles.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0 });
  }
  let pNext = 0;
  function burst(x, z, color, count) {
    if (reducedMotion || quality === 'low') return;
    const n = quality === 'high' ? count : Math.ceil(count / 2);
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
    if (!lastState) return;
    for (let i = 0; i < lastState.balls.length; i++) {
      const b = lastState.balls[i];
      const v = ballViews[b.n];
      if (!v) continue;
      const x = frame[i * 2], y = frame[i * 2 + 1];
      if (x === null || x === undefined) { v.mesh.visible = false; v.ring.visible = false; }
      else { v.mesh.visible = true; v.mesh.position.set(x, TABLE_TOP + T.R, -y); v.ring.position.set(x, TABLE_TOP + 0.002, -y); }
    }
  }

  let lastState = null;
  let lastTime = performance.now();
  function loop(now) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (playing) {
      const p = playing;
      const elapsed = (now - p.start) / 1000;
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

    // camera shake (big events only; never under reduced motion)
    if (shake > 0 && !reducedMotion) {
      shake = Math.max(0, shake - dt * 2.5);
      const s = shake * 0.02;
      camera.position.set((Math.random() - 0.5) * s, CAM.y + (Math.random() - 0.5) * s, CAM.z);
      camera.lookAt(0, 0, -0.08);
    } else if (camera.position.y !== CAM.y || camera.position.x !== 0) {
      camera.position.set(0, CAM.y, CAM.z);
      camera.lookAt(0, 0, -0.08);
    }

    renderer.render(scene, camera);
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

  function resize() {
    const w = host.clientWidth || 640, h = host.clientHeight || 480;
    const cap = quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    if (opts.onContextLost) opts.onContextLost();
  });

  buildEnvironment();
  buildTable();
  resize();
  raf = requestAnimationFrame(loop);

  return {
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
          if (!v) continue;
          v.mesh.visible = !b.potted;
          v.ring.visible = !b.potted;
          v.mesh.position.set(b.x, TABLE_TOP + T.R, -b.y);
          v.ring.position.set(b.x, TABLE_TOP + 0.002, -b.y);
        }
      }
    },
    playTrace(trace, physics, cbs) {
      const p = { trace, physics: physics || [], cbs: cbs || {}, start: performance.now(), fi: 0, pi: 0, tick0: lastState ? lastState.tick : 0 };
      playing = p;
    },
    skipTrace,
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
    setLegalTargets(nums) {
      const set = new Set(nums || []);
      for (const n in ballViews) {
        const v = ballViews[n];
        v.ring.material.opacity = set.has(Number(n)) && v.mesh.visible ? 0.85 : 0;
      }
    },
    setPlacement(on) { if (!on) placeGhost.visible = false; },
    setPlacementGhost(x, y) {
      if (x == null) { placeGhost.visible = false; return; }
      placeGhost.visible = true;
      placeGhost.position.set(x, TABLE_TOP + T.R, -y);
    },
    tablePointFromScreen,
    burstAt(x, y, color, big) {
      burst(x, -y, color || 0xffe9a0, big ? 22 : 10);
      if (big && !reducedMotion) shake = 1;
    },
    setTheme(t) { theme = t; buildEnvironment(); buildTable(); },
    setQuality(q) {
      quality = q;
      key.castShadow = q === 'high';
      renderer.shadowMap.enabled = q === 'high';
      resize();
    },
    setHighContrast(b) {
      highContrast = !!b;
      if (lastState) { const s = lastState; lastState = null; this.setSnapshot(s); }
    },
    setReducedMotion(b) { reducedMotion = !!b; if (b) shake = 0; },
    resize,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const d of disposables) if (d.dispose) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };
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

  function toScreen(x, y) { return { x: ox + (x - T.MIN_X) * scale, y: oy + (y - T.MIN_Y) * scale }; }
  function resize() {
    const w = host.clientWidth || 640, h = host.clientHeight || 480;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    const tl = toScreen(T.MIN_X - 0.2, T.MIN_Y - 0.2);
    const br = toScreen(T.MAX_X + 0.2, T.MAX_Y + 0.2);
    g.fillStyle = hex(p.wood); g.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    const cl = toScreen(T.MIN_X, T.MIN_Y), cr = toScreen(T.MAX_X, T.MAX_Y);
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
      const fi = Math.min(p.trace.frames.length - 1, Math.floor((now - p.start) / (1000 / 60)));
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
    setAim(state, a) { aimMilli = a; if (state) lastState = JSON.parse(JSON.stringify(state)); draw(); },
    setLegalTargets(nums) { legalSet = new Set(nums || []); draw(); },
    setPlacement(on) { if (!on) { placeG = null; draw(); } },
    setPlacementGhost(x, y) { placeG = x == null ? null : { x, y }; draw(); },
    tablePointFromScreen(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      return { x: T.MIN_X + (cx - rect.left - ox) / scale, y: T.MIN_Y + (cy - rect.top - oy) / scale };
    },
    burstAt() {},
    setTheme(t) { theme = t; draw(); },
    setQuality() {},
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
