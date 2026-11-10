'use strict';

// ===================== Setup =====================
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1, SCALE = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  SCALE = clamp(Math.min(W / 1300, H / 850), 0.5, 1.4);
}
window.addEventListener('resize', resize);

// ===================== Helpers =====================
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const lerp = (a, b, t) => a + (b - a) * t;
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function norm(x, y) { const l = Math.hypot(x, y); return l > 1e-6 ? [x / l, y / l] : [0, 0]; }
function fmtTime(t) { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// ===================== Constants =====================
const WORLD_W = 8200, WORLD_H = 1600;
const SHIP = { x0: 200, x1: 1100, cy: 800, hw: 90 };
const SHORE_X = 7700;
const SINK_TIME = 12;
const DECK_SPEED = 120, SWIM = 100, SPRINT = 165, EXHAUST_SPEED = 50, BERG_WALK = 70;
const CLIMB_RANGE = 36;
const SHARK_MINX = 1250, SHARK_MAXX = SHORE_X - 260;
const DIFFS = [
  { sharks: 10, patrol: 55, chase: 118, detect: 260, chaseTime: 5.5 },
  { sharks: 16, patrol: 62, chase: 130, detect: 290, chaseTime: 6.5 },
  { sharks: 24, patrol: 70, chase: 142, detect: 360, chaseTime: 7.5 },
];
const BOT_NAMES = ['Molly', 'Archie', 'Edith', 'Walter', 'Violet', 'Harold', 'Agnes', 'Bertie', 'Clara', 'Fred', 'Mabel', 'Percy'];
const COLORS = ['#ff5a5a', '#5ad1ff', '#7dff6a', '#ff9de2', '#b48cff', '#ff9f43', '#00e0b0', '#ffffff'];

function shoreX(y) { return SHORE_X + 40 * Math.sin(y / 170) + 22 * Math.sin(y / 63 + 1); }
function shipHalfW(x) {
  const t = (x - SHIP.x0) / (SHIP.x1 - SHIP.x0);
  if (t < 0 || t > 1) return 0;
  if (t > 0.78) return SHIP.hw * Math.pow(1 - (t - 0.78) / 0.22, 0.6);
  if (t < 0.06) return SHIP.hw * (0.55 + 0.45 * Math.sqrt(t / 0.06));
  return SHIP.hw;
}

// ===================== Sound =====================
let actx = null, muted = false;
function audio() {
  if (muted) return null;
  try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { return null; }
  return actx;
}
function tone(freq, freq2, dur, type = 'sine', vol = 0.2, delay = 0) {
  const a = audio(); if (!a) return;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0); o.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t0 + dur);
  g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.05);
}
function noise(dur, vol = 0.3, cutoff = 1200) {
  const a = audio(); if (!a) return;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
  const g = a.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(a.destination); src.start();
}
const sfx = {
  splash: () => noise(0.45, 0.35, 900),
  bite: () => { tone(110, 40, 0.3, 'square', 0.18); noise(0.15, 0.3, 500); },
  climb: () => tone(300, 700, 0.15, 'triangle', 0.15),
  hop: () => tone(500, 250, 0.12, 'triangle', 0.12),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.25, 'triangle', 0.18, i * 0.12)),
  lose: () => tone(400, 80, 1.0, 'sawtooth', 0.12),
  horn: () => { tone(98, 96, 1.6, 'sawtooth', 0.08); tone(147, 145, 1.6, 'sawtooth', 0.05); },
  warn: () => tone(880, 880, 0.08, 'square', 0.06),
};

// ===================== Input =====================
const keys = {};
let actionPressed = false;
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (!keys[k] && (k === ' ' || k === 'e')) actionPressed = true;
  keys[k] = true;
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if (k === 'r' && game.state === 'playing') startGame();
  if (k === 'm') muted = !muted;
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

const touch = { enabled: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0, sprint: false, sprintId: null, action: false };
function touchButtons() {
  return {
    action: { x: W - 80, y: H - 95, r: 46, label: 'JUMP' },
    sprint: { x: W - 190, y: H - 60, r: 36, label: 'SPRINT' },
  };
}
function buttonAt(x, y) {
  const b = touchButtons();
  if (dist(x, y, b.action.x, b.action.y) < b.action.r + 10) return 'action';
  if (dist(x, y, b.sprint.x, b.sprint.y) < b.sprint.r + 10) return 'sprint';
  return null;
}
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault(); touch.enabled = true; audio();
  for (const t of e.changedTouches) {
    const b = buttonAt(t.clientX, t.clientY);
    if (b === 'action') touch.action = true;
    else if (b === 'sprint') { touch.sprint = true; touch.sprintId = t.identifier; }
    else if (touch.id === null) { touch.id = t.identifier; touch.ox = t.clientX; touch.oy = t.clientY; touch.dx = touch.dy = 0; }
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier !== touch.id) continue;
    let vx = t.clientX - touch.ox, vy = t.clientY - touch.oy;
    const l = Math.hypot(vx, vy);
    if (l > 60) { touch.ox += vx * (1 - 60 / l); touch.oy += vy * (1 - 60 / l); vx = t.clientX - touch.ox; vy = t.clientY - touch.oy; }
    touch.dx = vx / 60; touch.dy = vy / 60;
  }
}, { passive: false });
function touchEnd(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === touch.id) { touch.id = null; touch.dx = touch.dy = 0; }
    if (t.identifier === touch.sprintId) { touch.sprint = false; touch.sprintId = null; }
  }
}
canvas.addEventListener('touchend', touchEnd);
canvas.addEventListener('touchcancel', touchEnd);

function playerInput() {
  let dx = 0, dy = 0;
  if (keys['arrowleft'] || keys['a']) dx -= 1;
  if (keys['arrowright'] || keys['d']) dx += 1;
  if (keys['arrowup'] || keys['w']) dy -= 1;
  if (keys['arrowdown'] || keys['s']) dy += 1;
  if (touch.id !== null && Math.hypot(touch.dx, touch.dy) > 0.2) { dx = touch.dx; dy = touch.dy; }
  const l = Math.hypot(dx, dy);
  if (l > 1) { dx /= l; dy /= l; }
  const out = { dx, dy, sprint: !!keys['shift'] || touch.sprint, action: actionPressed || touch.action };
  actionPressed = false; touch.action = false;
  return out;
}

// ===================== Game state =====================
let game = { state: 'menu' };

function genBergs() {
  const bergs = [];
  let tries = 0;
  while (bergs.length < 64 && tries < 6000) {
    tries++;
    const r = rand(45, 115);
    const x = rand(1350, 7420), y = rand(r + 60, WORLD_H - r - 60);
    if (bergs.some((b) => dist(b.x, b.y, x, y) < b.r + r + 110)) continue;
    const n = Math.floor(rand(11, 17)), pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.15, 0.15), rr = r * rand(0.88, 1.12);
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
    const cracks = [];
    for (let i = 0; i < 3; i++) { const a = rand(0, 6.28), l = rand(0.2, 0.5) * r; cracks.push([Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2, Math.cos(a) * l, Math.sin(a) * l]); }
    bergs.push({ x, y, r, pts, cracks });
  }
  return bergs;
}

function makeSwimmer(name, color, isBot) {
  const s = {
    name, color, isBot, state: 'ship',
    x: rand(SHIP.x0 + 90, SHIP.x1 - 260), y: SHIP.cy + rand(-50, 50),
    vx: 0, vy: 0, face: 0, hp: 100, stamina: 100, invuln: 0, anim: rand(0, 10),
    berg: null, place: 0, finishTime: 0, cause: '', deathTime: 0, moving: false, sprinting: false,
  };
  if (isBot) {
    s.brain = {
      t: 0, out: { dx: 0, dy: 0, sprint: false, action: false },
      react: rand(0.12, 0.35), caution: rand(0.7, 1.35), bravery: rand(0.75, 1.25),
      restAt: rand(22, 40), leaveAt: rand(65, 95), jumpAt: rand(1.5, SINK_TIME * 0.8),
      laneY: rand(250, WORLD_H - 250), deckT: null, lastX: 0, stuckT: 0, bergT: 0,
    };
  }
  return s;
}

function makeShark(i, n, d) {
  const homeX = lerp(1600, SHARK_MAXX - 100, n > 1 ? i / (n - 1) : 0.5);
  const y = rand(150, WORLD_H - 150);
  return {
    x: homeX + rand(-200, 200), y, angle: rand(0, 6.28), homeX, state: 'patrol', target: null, berg: null,
    wx: homeX, wy: y, timer: rand(2, 6), think: rand(0, 0.5), chaseT: 0, orbitA: 0, orbitDir: 1, wag: rand(0, 6), speed: d.patrol,
  };
}

function startGame() {
  const nBots = parseInt(document.getElementById('bots').value, 10);
  const diff = DIFFS[parseInt(document.getElementById('diff').value, 10)];
  let name = document.getElementById('name').value.trim() || 'You';
  try { localStorage.setItem('sos-name', name); } catch (e) { /* ignore */ }

  const swimmers = [];
  const player = makeSwimmer(name, '#ffcf5a', false);
  swimmers.push(player);
  const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < nBots; i++) swimmers.push(makeSwimmer(names[i], COLORS[i % COLORS.length], true));

  const sharks = [];
  for (let i = 0; i < diff.sharks; i++) sharks.push(makeShark(i, diff.sharks, diff));

  game = {
    state: 'playing', time: 0, diff, swimmers, sharks, player, bergs: genBergs(), particles: [],
    feed: [], msg: null, finishCount: 0, floodX: SHIP.x1 + 10, shake: 0,
    cam: { x: player.x + 300, y: SHIP.cy }, follow: player, resultsAt: 0, resultsShown: false, sunkMsg: false,
    palms: Array.from({ length: 14 }, () => ({ x: rand(SHORE_X + 160, WORLD_W - 60), y: rand(80, WORLD_H - 80), r: rand(28, 44), a: rand(0, 6) })),
  };
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  document.getElementById('menu').classList.add('hidden');
  document.getElementById('results').classList.add('hidden');
  showMsg('The ship is sinking! Jump overboard!', 3.5, '#ffcf5a');
  sfx.horn();
}

function showMsg(text, dur = 2.5, color = '#fff') { game.msg = { text, t: dur, max: dur, color }; }
function addFeed(text, color = '#fff') { game.feed.unshift({ text, t: 6, color }); if (game.feed.length > 5) game.feed.pop(); }
function particle(p) { game.particles.push(Object.assign({ vx: 0, vy: 0, life: 1, max: 1, r: 10 }, p)); }
function splash(x, y, big = 1) {
  particle({ type: 'ring', x, y, life: 0.8, max: 0.8, r: 8 * big });
  particle({ type: 'ring', x, y, life: 1.1, max: 1.1, r: 4 * big });
  for (let i = 0; i < 8 * big; i++) { const a = rand(0, 6.28), sp = rand(30, 90); particle({ type: 'drop', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, max: 0.5, r: rand(2, 4) }); }
}
function nearCam(x, y, m = 900) { return Math.abs(x - game.cam.x) < m && Math.abs(y - game.cam.y) < m; }

function nearestBerg(x, y, filter) {
  let best = null, be = 1e9;
  for (const b of game.bergs) {
    if (filter && !filter(b)) continue;
    const e = dist(x, y, b.x, b.y) - b.r;
    if (e < be) { be = e; best = b; }
  }
  return best ? { b: best, edge: be } : null;
}

// ===================== Swimmer logic =====================
function startJump(s, tx, ty, dur) {
  s.state = 'jumping'; s.jfx = s.x; s.jfy = s.y; s.jtx = tx; s.jty = ty; s.jt = 0; s.jdur = dur; s.vx = s.vy = 0;
}
function jumpOverboard(s, inp) {
  let side = Math.abs(inp.dy) > 0.1 ? Math.sign(inp.dy) : (s.y >= SHIP.cy ? 1 : -1);
  const tx = s.x + inp.dx * 40;
  startJump(s, tx, SHIP.cy + side * (shipHalfW(tx) + 55), 0.55);
}
function enterWater(s) {
  s.state = 'water';
  splash(s.x, s.y, 1.4);
  if (s === game.player || (game.follow === s)) sfx.splash();
}
function finish(s) {
  s.state = 'safe'; s.place = ++game.finishCount; s.finishTime = game.time;
  s.beachX = shoreX(s.y) + rand(60, 220); s.vx = s.vy = 0;
  addFeed(`${s.name} reached the island! (${ordinal(s.place)})`, '#7dff6a');
  if (s === game.player) {
    sfx.win(); showMsg(`YOU MADE IT! ${ordinal(s.place)} place`, 4, '#7dff6a');
    game.resultsAt = game.time + 2;
  }
}
function kill(s, cause) {
  if (s.state === 'dead') return;
  s.state = 'dead'; s.cause = cause; s.deathTime = game.time;
  for (let i = 0; i < 10; i++) particle({ type: 'bubble', x: s.x + rand(-10, 10), y: s.y + rand(-10, 10), life: rand(0.6, 1.6), max: 1.6, r: rand(2, 5) });
  const how = cause === 'shark' ? 'was eaten by a shark' : 'ran out of energy';
  addFeed(`${s.name} ${how}!`, '#ff6b6b');
  if (s === game.player) {
    sfx.lose();
    showMsg(cause === 'shark' ? 'CHOMP! You were eaten!' : 'You were too exhausted to go on...', 4, '#ff6b6b');
    game.resultsAt = game.time + 2;
  }
}
function bite(sh, s) {
  if (s.invuln > 0 || s.state !== 'water') return;
  s.hp -= 40; s.invuln = 1.5;
  s.vx += Math.cos(sh.angle) * 220; s.vy += Math.sin(sh.angle) * 220;
  particle({ type: 'blood', x: s.x, y: s.y, life: 1.2, max: 1.2, r: 14 });
  particle({ type: 'blood', x: s.x + rand(-8, 8), y: s.y + rand(-8, 8), life: 1.6, max: 1.6, r: 8 });
  if (s === game.player) { sfx.bite(); game.shake = 14; showMsg('OUCH! Get to an iceberg!', 1.8, '#ff6b6b'); }
  sh.state = 'retreat'; sh.timer = 1.8; sh.target = null; sh.angle += Math.PI * rand(0.7, 1.3);
  if (s.hp <= 0) { s.hp = 0; kill(s, 'shark'); }
}

function pushOutOfBergs(o, pad) {
  for (const b of game.bergs) {
    const dx = o.x - b.x, dy = o.y - b.y;
    if (Math.abs(dx) > b.r + pad || Math.abs(dy) > b.r + pad) continue;
    const d = Math.hypot(dx, dy), min = b.r + pad;
    if (d < min) {
      const [nx, ny] = d > 1e-3 ? [dx / d, dy / d] : [1, 0];
      o.x = b.x + nx * min; o.y = b.y + ny * min;
    }
  }
}

function updateSwimmer(s, inp, dt) {
  s.invuln = Math.max(0, s.invuln - dt);
  s.anim += dt;
  const moving = Math.abs(inp.dx) + Math.abs(inp.dy) > 0.05;
  s.moving = moving; s.sprinting = false;
  if (moving) s.face = Math.atan2(inp.dy, inp.dx);

  switch (s.state) {
    case 'ship': {
      const nx = Math.max(SHIP.x0 + 30, s.x + inp.dx * DECK_SPEED * dt);
      const ny = s.y + inp.dy * DECK_SPEED * dt;
      const hw = shipHalfW(nx) - 14;
      if (inp.action || Math.abs(ny - SHIP.cy) > hw) { jumpOverboard(s, inp); break; }
      s.x = nx; s.y = ny;
      if (s.x >= game.floodX - 6) {
        enterWater(s);
        if (s === game.player) showMsg('The water swept you off the deck! Swim!', 2.5, '#5ad1ff');
      }
      break;
    }
    case 'jumping':
    case 'climbing': {
      s.jt += dt;
      const k = Math.min(1, s.jt / s.jdur);
      s.x = lerp(s.jfx, s.jtx, k); s.y = lerp(s.jfy, s.jty, k);
      if (k >= 1) {
        if (s.state === 'jumping') { pushOutOfBergs(s, 12); enterWater(s); }
        else { s.state = 'iceberg'; }
      }
      break;
    }
    case 'water': {
      let speed = SWIM;
      if (s.stamina <= 0) {
        speed = EXHAUST_SPEED; s.hp -= 5 * dt;
        if (s.hp <= 0) { s.hp = 0; kill(s, 'exhausted'); break; }
      } else if (inp.sprint && moving) {
        speed = SPRINT; s.stamina -= 14 * dt; s.sprinting = true;
      } else {
        s.stamina -= (moving ? 1.3 : 0.7) * dt;
      }
      s.stamina = Math.max(0, s.stamina);
      const k = Math.min(1, dt * 5);
      s.vx += (inp.dx * speed - s.vx) * k; s.vy += (inp.dy * speed - s.vy) * k;
      s.x += s.vx * dt; s.y += s.vy * dt;
      pushOutOfBergs(s, 12);
      // Hull of the sinking ship
      if (s.x < game.floodX && s.x > SHIP.x0 - 10) {
        const hw = shipHalfW(s.x) + 10;
        if (hw > 10 && Math.abs(s.y - SHIP.cy) < hw) s.y = SHIP.cy + (s.y >= SHIP.cy ? 1 : -1) * hw;
      }
      s.x = clamp(s.x, 40, WORLD_W - 20); s.y = clamp(s.y, 40, WORLD_H - 40);
      if (s.x > shoreX(s.y)) { finish(s); break; }
      if (inp.action) {
        const nb = nearestBerg(s.x, s.y);
        if (nb && nb.edge < CLIMB_RANGE) {
          const b = nb.b, [nx, ny] = norm(s.x - b.x, s.y - b.y);
          s.berg = b; startJump(s, b.x + nx * b.r * 0.6, b.y + ny * b.r * 0.6, 0.45); s.state = 'climbing';
          if (s === game.player) sfx.climb();
        }
      }
      if (s === game.player) {
        if (s.stamina < 25 && s.stamina > 0 && !s.warnedTired) { s.warnedTired = true; showMsg('Getting tired... rest on an iceberg!', 2.5, '#ffcf5a'); }
        if (s.stamina > 50) s.warnedTired = false;
        if (s.stamina <= 0 && !s.warnedExhausted) { s.warnedExhausted = true; showMsg('EXHAUSTED! Climb an iceberg NOW!', 2.5, '#ff6b6b'); }
        if (s.stamina > 10) s.warnedExhausted = false;
      }
      break;
    }
    case 'iceberg': {
      const b = s.berg;
      s.stamina = Math.min(100, s.stamina + 12 * dt);
      s.hp = Math.min(100, s.hp + 2 * dt);
      let nx = s.x + inp.dx * BERG_WALK * dt, ny = s.y + inp.dy * BERG_WALK * dt;
      const dx = nx - b.x, dy = ny - b.y, d = Math.hypot(dx, dy), maxR = b.r * 0.72;
      if (d > maxR) { nx = b.x + (dx / d) * maxR; ny = b.y + (dy / d) * maxR; }
      s.x = nx; s.y = ny;
      if (inp.action) {
        const a = moving ? Math.atan2(inp.dy, inp.dx) : s.face;
        startJump(s, b.x + Math.cos(a) * (b.r + 30), b.y + Math.sin(a) * (b.r + 30), 0.4);
        s.berg = null;
        if (s === game.player) sfx.hop();
      }
      break;
    }
    case 'safe': {
      s.x = lerp(s.x, s.beachX, Math.min(1, dt * 1.5));
      break;
    }
  }
}

// ===================== Bot AI =====================
function botThink(s, dt) {
  const B = s.brain;
  B.t -= dt;
  if (B.t <= 0) {
    B.t = B.react * rand(0.6, 1.4);
    B.out = botDecide(s);
  }
  const res = Object.assign({}, B.out);
  B.out.action = false; // one-shot
  return res;
}

function botDecide(s) {
  const B = s.brain;
  const out = { dx: 0, dy: 0, sprint: false, action: false };
  const sharks = game.sharks;

  if (s.state === 'ship') {
    if (game.time > B.jumpAt) { out.action = true; out.dy = Math.random() < 0.5 ? -1 : 1; return out; }
    if (!B.deckT || dist(s.x, s.y, B.deckT[0], B.deckT[1]) < 15) B.deckT = [rand(SHIP.x0 + 60, game.floodX - 120), SHIP.cy + rand(-55, 55)];
    [out.dx, out.dy] = norm(B.deckT[0] - s.x, B.deckT[1] - s.y);
    out.dx *= 0.7; out.dy *= 0.7;
    return out;
  }

  if (s.state === 'iceberg') {
    const b = s.berg;
    B.bergT += B.react;
    let nearest = 1e9, besieged = false;
    for (const sh of sharks) {
      const d = dist(sh.x, sh.y, s.x, s.y);
      if (sh.state === 'circle' && sh.berg === b && d < b.r + 140) besieged = true;
      const danger = sh.state === 'chase' || (sh.state === 'circle' && sh.berg === b) ||
        (sh.state === 'patrol' && Math.cos(sh.angle - Math.atan2(s.y - sh.y, s.x - sh.x)) > 0);
      if (danger && d < nearest) nearest = d;
    }
    const clearR = 220 * B.bravery;
    const rested = s.stamina >= B.leaveAt || (B.bergT > 15 && s.stamina > 45);
    // Shuffle to the island-facing side while waiting.
    const tx = b.x + b.r * 0.55, ty = b.y + clamp((B.laneY - b.y) * 0.3, -b.r * 0.3, b.r * 0.3);
    if (dist(s.x, s.y, tx, ty) > 8) { [out.dx, out.dy] = norm(tx - s.x, ty - s.y); out.dx *= 0.5; out.dy *= 0.5; }
    if (rested && !besieged && (nearest > clearR || (B.bergT > 12 && nearest > 130))) {
      [out.dx, out.dy] = norm(1, clamp((B.laneY - s.y) / 500, -0.6, 0.6));
      out.action = true;
      B.leaveAt = rand(55, 90);
    }
    return out;
  }

  if (s.state !== 'water') return out;
  B.bergT = 0;

  // Occasionally pick a new lane, and unstick
  B.stuckT += B.react;
  if (B.stuckT > 4) {
    if (s.x - B.lastX < 60) B.laneY = clamp(s.y + rand(-400, 400), 200, WORLD_H - 200);
    else if (Math.random() < 0.15) B.laneY = rand(250, WORLD_H - 250);
    B.lastX = s.x; B.stuckT = 0;
  }

  // Threat detection
  let threat = null, td = 1e9, chasing = false;
  for (const sh of sharks) {
    const d = dist(sh.x, sh.y, s.x, s.y);
    const chasingMe = sh.state === 'chase' && sh.target === s;
    const scary = (sh.state === 'patrol' || sh.state === 'circle') &&
      Math.cos(sh.angle - Math.atan2(s.y - sh.y, s.x - sh.x)) > 0.4;
    if ((chasingMe && d < 450) || (scary && d < 120 * B.caution)) {
      if (d < td) { td = d; threat = sh; chasing = chasingMe; }
    }
  }

  if (threat) {
    const nb = nearestBerg(s.x, s.y, (b) => dist(threat.x, threat.y, b.x, b.y) > dist(s.x, s.y, b.x, b.y) * 0.5 || td > 260);
    if (nb && nb.edge < 260) {
      [out.dx, out.dy] = norm(nb.b.x - s.x, nb.b.y - s.y);
      out.sprint = td < 280 && s.stamina > 3;
      if (nb.edge < CLIMB_RANGE - 6) out.action = true;
      return out;
    }
    let [fx, fy] = norm(s.x - threat.x, s.y - threat.y);
    [out.dx, out.dy] = norm(fx + 0.6, fy);
    out.sprint = s.stamina > 3;
    return out;
  }

  // Tired: find an iceberg ahead to rest on
  if (s.stamina < B.restAt) {
    const nb = nearestBerg(s.x, s.y, (b) => b.x > s.x - 80);
    if (nb && nb.edge < 650) {
      [out.dx, out.dy] = norm(nb.b.x - s.x, nb.b.y - s.y);
      if (nb.edge < CLIMB_RANGE - 6) out.action = true;
      return out;
    }
  }

  // Cruise to the island, steering around icebergs and sharks
  let [dx, dy] = norm(shoreX(B.laneY) + 100 - s.x, B.laneY - s.y);
  let ax = dx, ay = dy;
  for (const b of game.bergs) {
    const cx = b.x - s.x, cy = b.y - s.y;
    if (Math.abs(cx) > 400 || Math.abs(cy) > 400) continue;
    const proj = cx * dx + cy * dy;
    if (proj <= 0 || proj > 280) continue;
    const px = cx - dx * proj, py = cy - dy * proj, pd = Math.hypot(px, py), need = b.r + 35;
    if (pd < need) {
      const w = ((need - pd) / need) * 1.6;
      let [nx, ny] = pd > 1 ? [-px / pd, -py / pd] : [-dy, dx];
      ax += nx * w; ay += ny * w;
    }
  }
  for (const sh of sharks) {
    const d = dist(sh.x, sh.y, s.x, s.y), R = 220 * B.caution;
    if (d < R && sh.state !== 'tired') {
      const [nx, ny] = norm(s.x - sh.x, s.y - sh.y), w = ((R - d) / R) * 1.0;
      ax += nx * w; ay += ny * w;
    }
  }
  [out.dx, out.dy] = norm(ax, ay);
  return out;
}

// ===================== Shark AI =====================
function chasersOf(s) { let n = 0; for (const sh of game.sharks) if (sh.state === 'chase' && sh.target === s) n++; return n; }
function findPrey(sh, range) {
  let best = null, bd = range;
  for (const s of game.swimmers) {
    if (s.state !== 'water' || s.invuln > 0.3 || s.x < SHARK_MINX - 80) continue;
    const d = dist(sh.x, sh.y, s.x, s.y);
    if (d < bd && chasersOf(s) < 2) { bd = d; best = s; }
  }
  return best;
}
function newWander(sh) {
  sh.wx = clamp(sh.homeX + rand(-650, 650), SHARK_MINX, SHARK_MAXX);
  sh.wy = rand(100, WORLD_H - 100);
  sh.timer = rand(6, 12);
}
function startChase(sh, t) {
  sh.state = 'chase'; sh.target = t; sh.chaseT = 0;
  if (t === game.player) { sfx.warn(); }
}

function updateShark(sh, dt) {
  const D = game.diff;
  sh.timer -= dt; sh.think -= dt;
  let tx = sh.wx, ty = sh.wy, speed = D.patrol, turn = 2.4;

  switch (sh.state) {
    case 'patrol': {
      if (dist(sh.x, sh.y, sh.wx, sh.wy) < 50 || sh.timer <= 0) newWander(sh);
      tx = sh.wx; ty = sh.wy;
      sh.ignoreT = Math.max(0, (sh.ignoreT || 0) - dt);
      if (sh.think <= 0 && sh.ignoreT <= 0) { sh.think = 0.35; const t = findPrey(sh, D.detect); if (t) startChase(sh, t); }
      break;
    }
    case 'chase': {
      const t = sh.target;
      if (t.state === 'iceberg' || t.state === 'climbing') {
        sh.state = 'circle'; sh.berg = t.berg; sh.timer = rand(3, 6);
        sh.orbitA = Math.atan2(sh.y - sh.berg.y, sh.x - sh.berg.x); sh.orbitDir = Math.random() < 0.5 ? 1 : -1;
        sh.target = null;
        break;
      }
      if (t.state !== 'water' && t.state !== 'jumping') { sh.state = 'patrol'; sh.target = null; newWander(sh); break; }
      tx = t.x + t.vx * 0.35; ty = t.y + t.vy * 0.35;
      speed = D.chase; turn = 3.1;
      sh.chaseT += dt;
      const d = dist(sh.x, sh.y, t.x, t.y);
      if (d < 30) bite(sh, t);
      else if (sh.chaseT > D.chaseTime || d > 620) { sh.state = 'tired'; sh.timer = 3; sh.target = null; newWander(sh); }
      break;
    }
    case 'circle': {
      const b = sh.berg, R = b.r + 80;
      sh.orbitA += sh.orbitDir * (80 / R) * dt;
      const a = sh.orbitA + sh.orbitDir * 0.5;
      tx = b.x + Math.cos(a) * R; ty = b.y + Math.sin(a) * R;
      speed = 80; turn = 3;
      if (sh.think <= 0) { sh.think = 0.3; const t = findPrey(sh, 300); if (t) { startChase(sh, t); break; } }
      if (sh.timer <= 0) { sh.state = 'patrol'; sh.ignoreT = 4; newWander(sh); const [ax, ay] = norm(sh.x - b.x, sh.y - b.y); sh.wx = clamp(b.x + ax * 600, SHARK_MINX, SHARK_MAXX); sh.wy = clamp(b.y + ay * 600, 100, WORLD_H - 100); sh.berg = null; }
      break;
    }
    case 'retreat': {
      tx = sh.x + Math.cos(sh.angle) * 100; ty = sh.y + Math.sin(sh.angle) * 100;
      speed = 110;
      if (sh.timer <= 0) { sh.state = 'patrol'; newWander(sh); }
      break;
    }
    case 'tired': {
      speed = 38;
      if (sh.timer <= 0) sh.state = 'patrol';
      break;
    }
  }

  sh.speed = lerp(sh.speed, speed, Math.min(1, dt * 2));
  const desired = Math.atan2(ty - sh.y, tx - sh.x);
  sh.angle += clamp(angDiff(sh.angle, desired), -turn * dt, turn * dt);
  sh.x += Math.cos(sh.angle) * sh.speed * dt;
  sh.y += Math.sin(sh.angle) * sh.speed * dt;
  pushOutOfBergs(sh, 22);
  sh.x = clamp(sh.x, SHARK_MINX, SHARK_MAXX);
  sh.y = clamp(sh.y, 50, WORLD_H - 50);
  sh.wag += dt * (2 + sh.speed / 25);
}

// ===================== Update =====================
function standings() {
  const key = (s) => s.state === 'safe' ? s.place : s.state === 'dead' ? 1e6 - s.deathTime : 1e4 - s.x / 10;
  return game.swimmers.slice().sort((a, b) => key(a) - key(b));
}

function update(dt) {
  game.time += dt;
  const p = clamp(game.time / SINK_TIME, 0, 1);
  game.floodX = SHIP.x1 + 10 - Math.pow(p, 1.5) * (SHIP.x1 - SHIP.x0 + 60);
  if (p >= 1 && !game.sunkMsg) { game.sunkMsg = true; if (game.player.state !== 'dead') showMsg('The ship is gone. Swim east to the island!', 3, '#5ad1ff'); }

  for (const s of game.swimmers) {
    if (s.state === 'dead') continue;
    const inp = s.isBot ? botThink(s, dt) : playerInput();
    updateSwimmer(s, inp, dt);
  }
  if (game.player.state === 'dead' || game.player.state === 'safe') playerInput(); // drain input

  for (const sh of game.sharks) updateShark(sh, dt);

  for (const pt of game.particles) { pt.life -= dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vx *= 0.95; pt.vy *= 0.95; }
  game.particles = game.particles.filter((pt) => pt.life > 0);
  if (game.time % 0.1 < dt) {
    // wakes
    for (const s of game.swimmers) if (s.state === 'water' && s.moving && nearCam(s.x, s.y)) particle({ type: 'wake', x: s.x - Math.cos(s.face) * 10, y: s.y - Math.sin(s.face) * 10, life: 0.9, max: 0.9, r: 5 });
    for (const sh of game.sharks) if (nearCam(sh.x, sh.y)) particle({ type: 'wake', x: sh.x - Math.cos(sh.angle) * 30, y: sh.y - Math.sin(sh.angle) * 30, life: 0.9, max: 0.9, r: 6 });
    if (game.floodX > SHIP.x0 - 40 && game.floodX < SHIP.x1 + 10) {
      const hw = shipHalfW(clamp(game.floodX, SHIP.x0, SHIP.x1));
      particle({ type: 'bubble', x: game.floodX + rand(-10, 30), y: SHIP.cy + rand(-hw, hw), life: 1.2, max: 1.2, r: rand(3, 7) });
    }
  }

  if (game.msg) { game.msg.t -= dt; if (game.msg.t <= 0) game.msg = null; }
  for (const f of game.feed) f.t -= dt;
  game.feed = game.feed.filter((f) => f.t > 0);
  game.shake = Math.max(0, game.shake - dt * 30);

  // Results
  if (game.resultsAt && !game.resultsShown && game.time >= game.resultsAt) { game.resultsShown = true; showResults(); }
  if (game.resultsShown && !document.getElementById('results').classList.contains('hidden') && game.time % 1 < dt) renderResults();

  // Camera
  const pl = game.player;
  if (pl.state === 'dead' && game.follow === pl) game.follow = null;
  if (!game.follow || game.follow.state === 'dead' || (game.follow !== pl && game.follow.state === 'safe')) {
    const alive = standings().filter((s) => s.state !== 'dead' && s.state !== 'safe');
    game.follow = alive[0] || (pl.state === 'safe' ? pl : game.follow);
  }
  const f = game.follow || pl;
  const lead = f.state === 'water' ? 120 : 0;
  const k = Math.min(1, dt * 3);
  game.cam.x = lerp(game.cam.x, f.x + lead, k);
  game.cam.y = lerp(game.cam.y, f.y, k);
  const vw = W / SCALE, vh = H / SCALE;
  game.cam.x = vw < WORLD_W ? clamp(game.cam.x, vw / 2, WORLD_W - vw / 2) : WORLD_W / 2;
  game.cam.y = vh < WORLD_H ? clamp(game.cam.y, vh / 2, WORLD_H - vh / 2) : WORLD_H / 2;
}

// ===================== Results UI =====================
function showResults() {
  const pl = game.player;
  document.getElementById('resTitle').textContent = pl.state === 'safe' ? `You made it! ${ordinal(pl.place)} place` : (pl.cause === 'shark' ? 'Eaten by a shark!' : 'Lost at sea...');
  renderResults();
  document.getElementById('results').classList.remove('hidden');
}
function renderResults() {
  const list = document.getElementById('resList');
  list.innerHTML = '';
  for (const s of standings()) {
    const li = document.createElement('li');
    if (s === game.player) li.className = 'you';
    let status;
    if (s.state === 'safe') status = `${ordinal(s.place)} · ${fmtTime(s.finishTime)}`;
    else if (s.state === 'dead') status = s.cause === 'shark' ? 'Eaten by a shark' : 'Exhausted';
    else status = `Still swimming (${Math.round(clamp((s.x - SHIP.x1) / (SHORE_X - SHIP.x1), 0, 1) * 100)}%)`;
    const left = document.createElement('span');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = s.color;
    left.appendChild(dot); left.appendChild(document.createTextNode(s.name));
    const right = document.createElement('span'); right.className = 'status'; right.textContent = status;
    li.appendChild(left); li.appendChild(right);
    list.appendChild(li);
  }
}

// ===================== Rendering =====================
function drawWater(vx0, vy0, vx1, vy1) {
  const g = ctx.createLinearGradient(0, 0, WORLD_W, 0);
  g.addColorStop(0, '#0a2c4a'); g.addColorStop(0.85, '#0e4467'); g.addColorStop(1, '#14708f');
  ctx.fillStyle = g;
  ctx.fillRect(vx0 - 10, vy0 - 10, vx1 - vx0 + 20, vy1 - vy0 + 20);
  // waves
  const S = 110, t = game.time;
  ctx.strokeStyle = 'rgba(180,230,255,0.13)'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let gx = Math.floor(vx0 / S) - 1; gx <= Math.ceil(vx1 / S); gx++) {
    for (let gy = Math.floor(vy0 / S) - 1; gy <= Math.ceil(vy1 / S); gy++) {
      const h = Math.abs(Math.sin(gx * 12.9898 + gy * 78.233) * 43758.5453) % 1;
      const x = gx * S + h * 80 + Math.sin(t * 0.8 + h * 6) * 10, y = gy * S + ((h * 7) % 1) * 80;
      const w = 10 + h * 14;
      ctx.moveTo(x - w, y); ctx.quadraticCurveTo(x, y - 6, x + w, y);
    }
  }
  ctx.stroke();
}

function drawIsland(vy0, vy1) {
  const y0 = Math.max(0, vy0 - 20), y1 = Math.min(WORLD_H, vy1 + 20);
  // shallows
  ctx.fillStyle = 'rgba(80,220,220,0.25)';
  ctx.beginPath(); ctx.moveTo(WORLD_W + 50, y0);
  for (let y = y0; y <= y1; y += 20) ctx.lineTo(shoreX(y) - 90 + 12 * Math.sin(y / 40 + game.time), y);
  ctx.lineTo(WORLD_W + 50, y1); ctx.closePath(); ctx.fill();
  // sand
  ctx.fillStyle = '#e8d29a';
  ctx.beginPath(); ctx.moveTo(WORLD_W + 50, y0);
  for (let y = y0; y <= y1; y += 20) ctx.lineTo(shoreX(y), y);
  ctx.lineTo(WORLD_W + 50, y1); ctx.closePath(); ctx.fill();
  // foam
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 4;
  ctx.beginPath();
  for (let y = y0; y <= y1; y += 20) { const x = shoreX(y) - 6 + 4 * Math.sin(y / 25 + game.time * 2); y === y0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke();
  // grass
  ctx.fillStyle = '#4c9a4a';
  ctx.beginPath(); ctx.moveTo(WORLD_W + 50, y0);
  for (let y = y0; y <= y1; y += 20) ctx.lineTo(shoreX(y) + 260 + 30 * Math.sin(y / 90), y);
  ctx.lineTo(WORLD_W + 50, y1); ctx.closePath(); ctx.fill();
  // palms
  for (const p of game.palms) {
    if (p.y < y0 - 60 || p.y > y1 + 60) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(p.x + 10, p.y + 10, p.r, p.r * 0.8, 0, 0, 7); ctx.fill();
    for (let i = 0; i < 6; i++) {
      const a = p.a + (i / 6) * Math.PI * 2 + Math.sin(game.time + p.x) * 0.05;
      ctx.fillStyle = i % 2 ? '#2f7a33' : '#3d9440';
      ctx.beginPath(); ctx.ellipse(p.x + Math.cos(a) * p.r * 0.5, p.y + Math.sin(a) * p.r * 0.5, p.r * 0.6, p.r * 0.22, a, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#7a5a2a'; ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, 7); ctx.fill();
  }
  // SOS sign / bonfire
  const fx = SHORE_X + 150, fy = WORLD_H / 2;
  if (fy > y0 && fy < y1) {
    const fl = 1 + 0.15 * Math.sin(game.time * 12);
    ctx.fillStyle = 'rgba(255,180,60,0.18)'; ctx.beginPath(); ctx.arc(fx, fy, 60 * fl, 0, 7); ctx.fill();
    ctx.fillStyle = '#ff7a1a'; ctx.beginPath(); ctx.arc(fx, fy, 14 * fl, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffd34a'; ctx.beginPath(); ctx.arc(fx, fy, 7 * fl, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(90,60,30,0.6)'; ctx.font = 'bold 80px Trebuchet MS'; ctx.textAlign = 'center';
    ctx.fillText('SAFE', SHORE_X + 330, fy + 30);
  }
}

function hullPath(inset) {
  const N = 40;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const x = SHIP.x0 + ((SHIP.x1 - SHIP.x0) * i) / N; ctx.lineTo(x, SHIP.cy - Math.max(0, shipHalfW(x) - inset)); }
  for (let i = N; i >= 0; i--) { const x = SHIP.x0 + ((SHIP.x1 - SHIP.x0) * i) / N; ctx.lineTo(x, SHIP.cy + Math.max(0, shipHalfW(x) - inset)); }
  ctx.closePath();
}

function drawShip() {
  const fx = game.floodX;
  if (fx < SHIP.x0 - 50) return;
  const { x0, x1, cy, hw } = SHIP, L = x1 - x0;
  // submerged silhouette
  hullPath(0); ctx.fillStyle = 'rgba(5,15,25,0.45)'; ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.rect(x0 - 30, cy - 200, fx - (x0 - 30), 400); ctx.clip();
  hullPath(0); ctx.fillStyle = '#151515'; ctx.fill();
  hullPath(6); ctx.fillStyle = '#f2efe6'; ctx.fill();
  hullPath(14); ctx.fillStyle = '#c69c62'; ctx.fill();
  ctx.strokeStyle = 'rgba(90,60,30,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); for (let y = cy - hw + 20; y < cy + hw - 14; y += 9) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); } ctx.stroke();
  // superstructure
  ctx.fillStyle = '#f7f5ee'; ctx.fillRect(x0 + L * 0.2, cy - hw * 0.45, L * 0.55, hw * 0.9);
  ctx.fillStyle = '#ffe9a0';
  for (let x = x0 + L * 0.22; x < x0 + L * 0.74; x += 18) { ctx.fillRect(x, cy - hw * 0.45 + 4, 6, 4); ctx.fillRect(x, cy + hw * 0.45 - 8, 6, 4); }
  // funnels
  for (const f of [0.3, 0.42, 0.54, 0.66]) {
    const x = x0 + L * f;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(x + 6, cy + 6, 18, 14, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#e09a32'; ctx.beginPath(); ctx.ellipse(x, cy, 18, 14, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(x, cy, 11, 8, 0, 0, 7); ctx.fill();
  }
  // masts
  ctx.fillStyle = '#6b4a24';
  ctx.beginPath(); ctx.arc(x0 + L * 0.1, cy, 5, 0, 7); ctx.arc(x0 + L * 0.85, cy, 5, 0, 7); ctx.fill();
  ctx.restore();
  // waterline foam
  if (fx > x0 && fx < x1 + 10) {
    const w = shipHalfW(clamp(fx, x0, x1)) + 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 5;
    ctx.beginPath();
    for (let y = cy - w; y <= cy + w; y += 6) ctx.lineTo(fx + 5 * Math.sin(y * 0.5 + game.time * 8), y);
    ctx.stroke();
  }
}

function drawBerg(b, highlight) {
  ctx.save(); ctx.translate(b.x, b.y);
  const poly = (s, ox = 0, oy = 0) => { ctx.beginPath(); b.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * s + ox, y * s + oy) : ctx.moveTo(x * s + ox, y * s + oy))); ctx.closePath(); };
  poly(1.32); ctx.fillStyle = 'rgba(140,215,250,0.16)'; ctx.fill();
  poly(1.12); ctx.fillStyle = 'rgba(170,230,255,0.25)'; ctx.fill();
  poly(1); const g = ctx.createRadialGradient(-b.r * 0.3, -b.r * 0.3, b.r * 0.1, 0, 0, b.r * 1.1);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#dff3fb'); g.addColorStop(1, '#a6d8ec');
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = highlight ? '#ffcf5a' : '#86c3dc'; ctx.lineWidth = highlight ? 4 : 2; ctx.stroke();
  poly(0.55, -b.r * 0.12, -b.r * 0.14); ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
  ctx.strokeStyle = 'rgba(120,180,210,0.6)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); for (const [ax, ay, bx, by] of b.cracks) { ctx.moveTo(ax, ay); ctx.lineTo(bx, by); } ctx.stroke();
  ctx.restore();
}

function drawShark(sh) {
  ctx.save(); ctx.translate(sh.x, sh.y); ctx.rotate(sh.angle);
  const wag = Math.sin(sh.wag) * 0.35;
  const hunting = sh.state === 'chase';
  // shadow body (underwater)
  ctx.fillStyle = hunting ? 'rgba(120,70,80,0.75)' : 'rgba(85,105,125,0.7)';
  ctx.beginPath(); ctx.ellipse(0, 0, 38, 11, 0, 0, 7); ctx.fill();
  // pectoral fins
  ctx.beginPath(); ctx.moveTo(8, -8); ctx.lineTo(-8, -26); ctx.lineTo(-4, -8); ctx.closePath();
  ctx.moveTo(8, 8); ctx.lineTo(-8, 26); ctx.lineTo(-4, 8); ctx.closePath(); ctx.fill();
  // tail
  ctx.save(); ctx.translate(-34, 0); ctx.rotate(wag);
  ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-22, -15); ctx.lineTo(-14, 0); ctx.lineTo(-22, 13); ctx.closePath(); ctx.fill();
  ctx.restore();
  // dorsal fin (above water)
  ctx.fillStyle = '#3c4a57';
  ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-10, -4); ctx.lineTo(-14, 0); ctx.lineTo(-10, 4); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(12, -3); ctx.lineTo(16, 0); ctx.lineTo(12, 3); ctx.stroke();
  // eyes
  ctx.fillStyle = hunting ? '#ff3b3b' : '#111';
  ctx.beginPath(); ctx.arc(28, -5, 2, 0, 7); ctx.arc(28, 5, 2, 0, 7); ctx.fill();
  ctx.restore();
  if (hunting && sh.target === game.player) {
    ctx.fillStyle = '#ff3b3b'; ctx.font = 'bold 22px Trebuchet MS'; ctx.textAlign = 'center';
    ctx.fillText('!', sh.x, sh.y - 30);
  }
}

function drawPerson(s, sc) {
  // top-down person standing (on ship / iceberg / beach)
  ctx.save(); ctx.translate(s.x, s.y); ctx.scale(sc, sc); ctx.rotate(s.face);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(3, 4, 11, 13, 0, 0, 7); ctx.fill();
  const step = s.moving ? Math.sin(s.anim * 12) * 4 : 0;
  ctx.fillStyle = '#2b2b3a';
  ctx.beginPath(); ctx.arc(step, -5, 3.5, 0, 7); ctx.arc(-step, 5, 3.5, 0, 7); ctx.fill();
  ctx.fillStyle = s.color; ctx.beginPath(); ctx.ellipse(0, 0, 7, 11, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#f1c27d'; ctx.beginPath(); ctx.arc(2, 0, 6, 0, 7); ctx.fill();
  ctx.fillStyle = '#5a3a1a'; ctx.beginPath(); ctx.arc(0, 0, 5.5, Math.PI * 0.5, Math.PI * 1.5); ctx.fill();
  ctx.restore();
}

function drawSwimmerInWater(s) {
  const flash = s.invuln > 0 && Math.floor(s.invuln * 10) % 2 === 0;
  if (flash) return;
  ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.face);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, 14 + Math.sin(s.anim * 4) * 2, 0, 7); ctx.stroke();
  // submerged body
  ctx.fillStyle = s.color; ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.ellipse(-12, 0, 13, 6, 0, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;
  // arms (front crawl)
  const rate = s.sprinting ? 14 : 8;
  const a1 = s.moving ? Math.sin(s.anim * rate) : 0.3, a2 = s.moving ? -a1 : -0.3;
  ctx.strokeStyle = '#f1c27d'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-2, -5); ctx.lineTo(4 + a1 * 10, -10 - Math.abs(a1) * 3);
  ctx.moveTo(-2, 5); ctx.lineTo(4 + a2 * 10, 10 + Math.abs(a2) * 3);
  ctx.stroke();
  // head with swim cap
  ctx.fillStyle = '#f1c27d'; ctx.beginPath(); ctx.arc(2, 0, 6.5, 0, 7); ctx.fill();
  ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(0, 0, 6.5, Math.PI * 0.5, Math.PI * 1.5); ctx.fill();
  ctx.restore();
}

function drawSwimmer(s) {
  switch (s.state) {
    case 'ship': case 'iceberg': case 'safe': drawPerson(s, 1); break;
    case 'water': drawSwimmerInWater(s); break;
    case 'jumping': case 'climbing': {
      const k = Math.min(1, s.jt / s.jdur), h = Math.sin(k * Math.PI);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(s.x + h * 12, s.y + h * 12, 9, 9, 0, 0, 7); ctx.fill();
      drawPerson(s, 1 + h * 0.5); break;
    }
  }
}

function drawLabel(s) {
  if (s.state === 'dead') return;
  const isP = s === game.player;
  ctx.font = `bold ${isP ? 14 : 12}px Trebuchet MS`; ctx.textAlign = 'center';
  const y = s.y - 24;
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(isP ? 'YOU' : s.name, s.x + 1, y + 1);
  ctx.fillStyle = isP ? '#ffcf5a' : s.color; ctx.fillText(isP ? 'YOU' : s.name, s.x, y);
  if (s.state !== 'safe' && s.state !== 'ship') {
    const w = 30;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(s.x - w / 2, y + 4, w, 4);
    ctx.fillStyle = s.hp > 50 ? '#7dff6a' : s.hp > 25 ? '#ffcf5a' : '#ff5a5a'; ctx.fillRect(s.x - w / 2, y + 4, (w * s.hp) / 100, 4);
  }
}

function drawParticles() {
  for (const p of game.particles) {
    const k = p.life / p.max;
    switch (p.type) {
      case 'ring': ctx.strokeStyle = `rgba(255,255,255,${k * 0.8})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (1 - k) * 40, 0, 7); ctx.stroke(); break;
      case 'drop': ctx.fillStyle = `rgba(220,245,255,${k})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); break;
      case 'bubble': ctx.strokeStyle = `rgba(220,245,255,${k * 0.8})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.5 - k * 0.5), 0, 7); ctx.stroke(); break;
      case 'wake': ctx.strokeStyle = `rgba(255,255,255,${k * k * 0.18})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (1 - k) * 18, 0, 7); ctx.stroke(); break;
      case 'blood': ctx.fillStyle = `rgba(200,30,40,${k * 0.5})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (1 - k) * 30, 0, 7); ctx.fill(); break;
    }
  }
}

function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

function drawBar(x, y, w, h, v, color, label) {
  roundRect(x, y, w, h, h / 2); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
  if (v > 0) { roundRect(x, y, Math.max(h, (w * v) / 100), h, h / 2); ctx.fillStyle = color; ctx.fill(); }
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px Trebuchet MS'; ctx.textAlign = 'left'; ctx.fillText(label, x + 8, y + h - 4);
}

function drawHUD() {
  const pl = game.player;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const small = W < 600;

  // Danger vignette
  const chased = game.sharks.some((sh) => sh.state === 'chase' && sh.target === pl);
  if (chased && pl.state === 'water') {
    const a = 0.25 + 0.15 * Math.sin(game.time * 10);
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(255,0,0,0)'); g.addColorStop(1, `rgba(255,0,0,${a})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // Off-screen shark arrows
  for (const sh of game.sharks) {
    if (!(sh.state === 'chase' && sh.target === pl)) continue;
    const sx = (sh.x - game.cam.x) * SCALE + W / 2, sy = (sh.y - game.cam.y) * SCALE + H / 2;
    if (sx > 0 && sx < W && sy > 0 && sy < H) continue;
    const a = Math.atan2(sy - H / 2, sx - W / 2);
    const ex = clamp(sx, 30, W - 30), ey = clamp(sy, 90, H - 30);
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(a);
    ctx.fillStyle = '#ff3b3b'; ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-10, -11); ctx.lineTo(-10, 11); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Bars
  const bw = small ? 130 : 180;
  drawBar(14, 14, bw, 18, pl.state === 'dead' ? 0 : pl.hp, pl.hp > 50 ? '#3fcf5a' : pl.hp > 25 ? '#e0b030' : '#e04040', 'HEALTH');
  drawBar(14, 38, bw, 18, pl.state === 'dead' ? 0 : pl.stamina, pl.stamina > 25 ? '#3aa8e8' : '#e07a30', 'STAMINA');

  // Progress bar
  const px0 = small ? 14 : W / 2 - 200, pw = small ? W - 28 : 400, py = small ? 66 : 20;
  roundRect(px0, py, pw, 10, 5); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
  ctx.fillStyle = '#e8d29a'; ctx.fillRect(px0 + pw - 6, py - 4, 6, 18);
  const prog = (x) => clamp((x - SHIP.x0) / (SHORE_X - SHIP.x0), 0, 1);
  ctx.fillStyle = '#ffffff55'; ctx.fillRect(px0 + prog(game.floodX) * pw - 1, py - 3, 2, 16);
  for (const s of game.swimmers) {
    if (s.state === 'dead') continue;
    const x = px0 + prog(s.x) * pw;
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, py + 5, s === pl ? 7 : 5, 0, 7); ctx.fill();
    if (s === pl) { ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke(); }
  }

  // Time & place
  ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = 'bold 18px Trebuchet MS';
  ctx.fillText(fmtTime(game.time), W - 14, 30);
  const st = standings(), place = st.indexOf(pl) + 1;
  ctx.font = 'bold 14px Trebuchet MS'; ctx.fillStyle = '#b9dcf2';
  ctx.fillText(pl.state === 'dead' ? 'OUT' : `${ordinal(place)} / ${st.length}`, W - 14, 50);
  if (muted) ctx.fillText('MUTED', W - 14, 68);

  // Feed
  ctx.textAlign = 'left'; ctx.font = '13px Trebuchet MS';
  game.feed.forEach((f, i) => { ctx.globalAlpha = Math.min(1, f.t); ctx.fillStyle = f.color; ctx.fillText(f.text, 14, (small ? 98 : 78) + i * 18); });
  ctx.globalAlpha = 1;

  // Big message
  if (game.msg) {
    const m = game.msg, a = Math.min(1, m.t * 2, (m.max - m.t) * 4 + 0.3);
    ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.font = `bold ${small ? 20 : 30}px Trebuchet MS`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(m.text, W / 2 + 2, H * 0.28 + 2);
    ctx.fillStyle = m.color; ctx.fillText(m.text, W / 2, H * 0.28);
    ctx.globalAlpha = 1;
  }

  // Context hint
  let hint = '';
  const key = touch.enabled ? 'JUMP' : 'SPACE';
  if (pl.state === 'ship') hint = `Walk off the edge or press ${key} to jump overboard`;
  else if (pl.state === 'water') { const nb = nearestBerg(pl.x, pl.y); if (nb && nb.edge < CLIMB_RANGE) hint = `${key}: climb onto the iceberg`; }
  else if (pl.state === 'iceberg') {
    let near = 1e9; for (const sh of game.sharks) near = Math.min(near, dist(sh.x, sh.y, pl.x, pl.y));
    hint = near < 260 ? 'Sharks nearby... wait for the coast to clear' : `Coast is clear! Aim and press ${key} to hop off`;
  }
  if (hint) {
    ctx.font = `bold ${small ? 14 : 18}px Trebuchet MS`; ctx.textAlign = 'center';
    const tw = ctx.measureText(hint).width + 30, hy = H - (touch.enabled ? 170 : 50);
    roundRect(W / 2 - tw / 2, hy - 22, tw, 32, 16); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(hint, W / 2, hy);
  }

  // Touch controls
  if (touch.enabled) {
    const b = touchButtons();
    for (const k of ['action', 'sprint']) {
      const btn = b[k], on = k === 'sprint' && touch.sprint;
      ctx.fillStyle = on ? 'rgba(255,207,90,0.6)' : 'rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.arc(btn.x, btn.y, btn.r, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 13px Trebuchet MS'; ctx.textAlign = 'center'; ctx.fillText(btn.label, btn.x, btn.y + 5);
    }
    if (touch.id !== null) {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(touch.ox, touch.oy, 60, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath(); ctx.arc(touch.ox + touch.dx * 60, touch.oy + touch.dy * 60, 22, 0, 7); ctx.fill();
    }
  }
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#06192b'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (game.state !== 'playing') return renderMenuBg();

  const sx = game.shake ? rand(-game.shake, game.shake) : 0, sy = game.shake ? rand(-game.shake, game.shake) : 0;
  const cx = game.cam.x, cy = game.cam.y;
  ctx.setTransform(DPR * SCALE, 0, 0, DPR * SCALE, DPR * (W / 2 - cx * SCALE + sx), DPR * (H / 2 - cy * SCALE + sy));
  const vx0 = cx - W / 2 / SCALE, vx1 = cx + W / 2 / SCALE, vy0 = cy - H / 2 / SCALE, vy1 = cy + H / 2 / SCALE;
  const inView = (x, y, m) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m;

  drawWater(vx0, vy0, vx1, vy1);
  if (vx1 > SHORE_X - 150) drawIsland(vy0, vy1);
  drawParticles();
  for (const sh of game.sharks) if (inView(sh.x, sh.y, 80)) drawShark(sh);
  if (vx0 < SHIP.x1 + 50) drawShip();
  const pl = game.player;
  const nb = pl.state === 'water' ? nearestBerg(pl.x, pl.y) : null;
  for (const b of game.bergs) if (inView(b.x, b.y, b.r * 1.4)) drawBerg(b, nb && nb.b === b && nb.edge < CLIMB_RANGE);
  const order = game.swimmers.filter((s) => s.state !== 'dead' && inView(s.x, s.y, 40));
  order.sort((a, b) => (a === pl) - (b === pl));
  for (const s of order) drawSwimmer(s);
  for (const s of order) drawLabel(s);
  drawHUD();
}

let menuT = 0;
function renderMenuBg() {
  menuT += 1 / 60;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0a2c4a'); g.addColorStop(1, '#06192b');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(180,230,255,0.12)'; ctx.lineWidth = 2;
  for (let y = 30; y < H; y += 50) {
    ctx.beginPath();
    for (let x = 0; x <= W; x += 20) ctx.lineTo(x, y + Math.sin(x / 60 + menuT + y) * 6);
    ctx.stroke();
  }
}

// ===================== Loop =====================
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.state === 'playing') update(dt);
  render();
  requestAnimationFrame(frame);
}

// ===================== UI wiring =====================
try { const n = localStorage.getItem('sos-name'); if (n) document.getElementById('name').value = n; } catch (e) { /* ignore */ }
document.getElementById('start').addEventListener('click', () => { audio(); startGame(); });
document.getElementById('again').addEventListener('click', () => startGame());
document.getElementById('watch').addEventListener('click', () => {
  document.getElementById('results').classList.add('hidden');
  game.follow = null;
});
document.getElementById('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { audio(); startGame(); } });

resize();
requestAnimationFrame(frame);
