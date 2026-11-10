/* BombRe (früher Funkenfeld) – Bomben-Arena für 2 bis 6 Spieler im Browser.
 *
 * Netzwerk: Peer-to-Peer über WebRTC (PeerJS). Der Browser, der den Raum erstellt,
 * ist der Gastgeber: Er prüft das Passwort, berechnet das Spiel und schickt den
 * Spielstand an alle. Die anderen schicken nur ihre Eingaben.
 * Zum Testen ohne Internet: ?local an die Adresse hängen, dann laufen die Tabs
 * desselben Browsers über einen BroadcastChannel.
 */
(() => {
'use strict';

// ---------- Konstanten ----------
let W = 15, H = 13;         // Feldgröße, wird über die Einstellungen gesetzt
// Wird beim Veröffentlichen durch die Commit-Kennung ersetzt (siehe .github/workflows/pages.yml)
const VERSION = '__VERSION__';
const T = 48;
const EMPTY = 0, WALL = 1, CRATE = 2;
const MAX_PLAYERS = 6;
const FUSE = 2.5;            // Sekunden bis zur Explosion
const FLAME_TIME = 0.55;     // Sekunden, die das Feuer brennt
const WIN_ROUNDS = 3;        // Standard: Runden bis zum Gesamtsieg
const MAX_WINS = 5;
const KICK_SPEED = 10;       // Felder pro Sekunde für gekickte Bomben
const BASE_SPEED = 3.6, SPEED_STEP = 0.6, MAX_SPEED = 6;
const ITEMS = ['bomb', 'fire', 'speed', 'kick', 'mega', 'pierce', 'shield', 'ghost', 'remote'];
const ITEM_WEIGHTS = [4, 4, 3, 1.5, 0.4, 0.4, 0.4, 0.4, 0.4];
const ITEM_ICON = { bomb: '💣', fire: '🔥', speed: '👟', kick: '🦶', mega: '🌟', pierce: '💥', shield: '🛡️', ghost: '👻', remote: '🧨' };
const MEGA = new Set(['mega', 'pierce', 'shield', 'ghost', 'remote']); // seltene Mega-Items
const REMOTE_MAX = 20;       // Sekunden, nach denen eine Fernzünder-Bombe spätestens von selbst hochgeht
const GHOST_TIME = 10;       // Sekunden durch Kisten und Bomben laufen
const SHIELD_GRACE = 1.5;    // Sekunden unverwundbar, nachdem der Schild ein Feuer abgefangen hat
const COLORS = ['#ff8a3d', '#3dc6ff', '#7ee06a', '#e56bff', '#ffd23d', '#ff5c8a'];
// Startplätze: vier Ecken, Spieler 5 und 6 oben und unten in der Mitte
const spawns = () => { const mx = (W - 1) >> 1; return [[1, 1], [W - 2, H - 2], [W - 2, 1], [1, H - 2], [mx, 1], [mx, H - 2]]; };
// Klassischer Modus: Feldgröße nach Spielerzahl (4: klassisch, 5–6: etwas größer)
const CLASSIC_SIZE = { 4: [15, 13], 5: [17, 13], 6: [19, 15] };
const MODES = { klassisch: 'Klassisch', individuell: 'Individuell' };
const SIZES = { klein: [11, 9], mittel: [15, 13], gross: [19, 15], riesig: [23, 17] };
const SIZE_LABEL = { klein: 'Klein (11 × 9)', mittel: 'Mittel (15 × 13)', gross: 'Groß (19 × 15)', riesig: 'Riesig (23 × 17)' };
const VARIANTS = { klassisch: 'Klassisch', schrumpf: 'Schrumpfendes Feld' };
const SHRINK_AT = 120;       // Runden haben kein Zeitlimit; im Modus „Schrumpfendes Feld“ fallen ab 2:00 Blöcke
const SHRINK_DUR = 58;       // so lange dauert das Schrumpfen, bis das Feld zu ist
const MEGA_LIST = ['mega', 'pierce', 'shield', 'ghost', 'remote'];
const MEGA_NAME = { mega: 'Megafeuer', pierce: 'Durchschlag', shield: 'Schild', ghost: 'Geist', remote: 'Fernzünder' };
// megaW: Gewichtung der einzelnen Mega-Items untereinander (0 = kommt nicht vor)
const DEFAULT_SETTINGS = { mode: 'klassisch', players: 4, variant: 'klassisch', size: 'mittel', items: 30, wins: WIN_ROUNDS, mega: 10,
  megaW: Object.fromEntries(MEGA_LIST.map((t) => [t, 100])) };
function cleanSettings(o) {
  o = o || {};
  const mode = MODES[o.mode] ? o.mode : DEFAULT_SETTINGS.mode;
  return {
    mode,
    players: MAX_PLAYERS, // feste Obergrenze, keine Einstellung mehr
    variant: VARIANTS[o.variant] ? o.variant : DEFAULT_SETTINGS.variant,
    size: SIZES[o.size] ? o.size : DEFAULT_SETTINGS.size,
    items: Math.max(0, Math.min(100, Math.round((+o.items || 0) / 5) * 5)),
    wins: Math.max(1, Math.min(MAX_WINS, o.wins | 0 || WIN_ROUNDS)),
    // Anteil der Mega-Items an allen Power-ups in Prozent (früher ein Schalter an/aus)
    mega: o.mega === true || o.mega === undefined ? DEFAULT_SETTINGS.mega : o.mega === false ? 0
      : Math.max(0, Math.min(100, Math.round((+o.mega || 0) / 5) * 5)),
    megaW: Object.fromEntries(MEGA_LIST.map((t) => {
      const v = o.megaW && o.megaW[t] !== undefined ? +o.megaW[t] : 100;
      return [t, Math.max(0, Math.min(100, Math.round((v || 0) / 5) * 5))];
    })),
  };
}
// Die tatsächlich gespielten Regeln. Klassisch: feste Regeln ohne Mega-Items, Feld passend zur Spielerzahl.
function rulesFor(st, joined) {
  st = cleanSettings(st);
  if (st.mode === 'klassisch') {
    const n = Math.max(4, Math.min(6, joined | 0));
    return { ...st, variant: 'klassisch', items: 30, wins: WIN_ROUNDS, mega: 0, dims: CLASSIC_SIZE[n] };
  }
  return { ...st, dims: SIZES[st.size] };
}
function applySize(w, h) {
  if (w === W && h === H) return;
  W = w; H = h;
  const cv = document.getElementById('cv'); cv.width = W * T; cv.height = H * T;
  document.documentElement.style.setProperty('--ar', (W / H).toFixed(4));
}
const TICK = 1 / 60, SEND_EVERY = 3; // Simulation 60 Hz, Senden 20 Hz
const PEER_PREFIX = 'funkenfeld-v1-';

const $ = (id) => document.getElementById(id);
const LOCAL = new URLSearchParams(location.search).has('local');

// ---------- Hilfen ----------
function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
async function hashPw(room, pw) {
  const text = 'funkenfeld|' + room + '|' + pw;
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261; // Notlösung ohne sichere Umgebung
  for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return 'f' + (h >>> 0).toString(16);
}
// st.mega: Wahrscheinlichkeit in Prozent, dass ein Power-up ein Mega-Item ist.
// st.megaW: Gewichtung der Mega-Items untereinander.
function pickItem(st) {
  const weights = st.megaW || DEFAULT_SETTINGS.megaW;
  const megaPool = MEGA_LIST.map((t) => [t, weights[t] || 0]).filter(([, w]) => w > 0);
  const mega = megaPool.length > 0 && Math.random() * 100 < st.mega;
  const pool = mega ? megaPool : ITEMS.map((t, i) => [t, ITEM_WEIGHTS[i]]).filter(([t]) => !MEGA.has(t));
  let r = Math.random() * pool.reduce((a, [, w]) => a + w, 0);
  for (const [t, w] of pool) { r -= w; if (r <= 0) return t; }
  return pool[0][0];
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Transport ----------
// Beide Varianten liefern Verbindungen mit send(obj), onData, onClose, close().
function wrapPeerConn(c) {
  const conn = { send: (o) => { if (c.open) c.send(o); }, close: () => c.close(), onData: null, onClose: null };
  c.on('data', (d) => conn.onData && conn.onData(d));
  c.on('close', () => conn.onClose && conn.onClose());
  c.on('error', () => conn.onClose && conn.onClose());
  return conn;
}
const Net = {
  host(room, onConn) {
    return new Promise((resolve, reject) => {
      if (LOCAL) return resolve(localHost(room, onConn));
      if (!window.Peer) return reject(new Error('Netzwerk-Bibliothek konnte nicht geladen werden.'));
      const peer = new Peer(PEER_PREFIX + room);
      peer.on('open', () => resolve({ close: () => peer.destroy() }));
      peer.on('connection', (c) => c.on('open', () => onConn(wrapPeerConn(c))));
      peer.on('error', (e) => {
        if (e.type === 'unavailable-id') reject(new Error('Diesen Raum gibt es schon. Wähle einen anderen Namen oder tritt bei.'));
        else reject(new Error('Verbindungsfehler: ' + e.type));
      });
    });
  },
  join(room) {
    return new Promise((resolve, reject) => {
      if (LOCAL) return resolve(localJoin(room));
      if (!window.Peer) return reject(new Error('Netzwerk-Bibliothek konnte nicht geladen werden.'));
      const peer = new Peer();
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; peer.destroy(); reject(new Error('Keine Antwort vom Gastgeber.')); } }, 15000);
      peer.on('open', () => {
        const c = peer.connect(PEER_PREFIX + room, { reliable: true });
        c.on('open', () => {
          if (done) return; done = true; clearTimeout(timer);
          const conn = wrapPeerConn(c);
          const close = conn.close; conn.close = () => { close(); peer.destroy(); };
          resolve(conn);
        });
      });
      peer.on('error', (e) => {
        if (done) return; done = true; clearTimeout(timer); peer.destroy();
        reject(new Error(e.type === 'peer-unavailable' ? 'Diesen Raum gibt es nicht. Prüfe den Raumnamen.' : 'Verbindungsfehler: ' + e.type));
      });
    });
  },
};
function localHost(room, onConn) {
  const bc = new BroadcastChannel('ff-' + room);
  const conns = new Map();
  bc.onmessage = ({ data: m }) => {
    if (m.to !== 'host') return;
    if (m.hello) {
      const conn = { send: (o) => bc.postMessage({ to: m.from, d: o }), close: () => { bc.postMessage({ to: m.from, bye: 1 }); conns.delete(m.from); }, onData: null, onClose: null };
      conns.set(m.from, conn); onConn(conn);
      bc.postMessage({ to: m.from, ok: 1 });
    } else if (m.bye) { const c = conns.get(m.from); conns.delete(m.from); c && c.onClose && c.onClose(); }
    else { const c = conns.get(m.from); c && c.onData && c.onData(m.d); }
  };
  return { close: () => { for (const [id] of conns) bc.postMessage({ to: id, bye: 1 }); bc.close(); } };
}
function localJoin(room) {
  return new Promise((resolve, reject) => {
    const bc = new BroadcastChannel('ff-' + room);
    const me = Math.random().toString(36).slice(2);
    const conn = { send: (o) => bc.postMessage({ to: 'host', from: me, d: o }), close: () => { bc.postMessage({ to: 'host', from: me, bye: 1 }); bc.close(); }, onData: null, onClose: null };
    const timer = setTimeout(() => { bc.close(); reject(new Error('Diesen Raum gibt es nicht. Prüfe den Raumnamen.')); }, 1500);
    bc.onmessage = ({ data: m }) => {
      if (m.to !== me) return;
      if (m.ok) { clearTimeout(timer); resolve(conn); }
      else if (m.bye) { conn.onClose && conn.onClose(); }
      else conn.onData && conn.onData(m.d);
    };
    bc.postMessage({ to: 'host', from: me, hello: 1 });
  });
}

// ---------- Spiellogik (läuft nur beim Gastgeber) ----------
class Game {
  constructor() {
    this.players = [];     // {id, name, color, slot, score, ...}
    this.phase = 'lobby';  // lobby | play | roundEnd | matchEnd
    this.round = 0;
    this.msg = '';
    this.time = 0;
    this.clock = 0;
    this.phaseTimer = 0;
    this.grid = new Array(W * H).fill(EMPTY);
    this.bombs = []; this.flames = []; this.items = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.rules = rulesFor(this.settings, 1);
    this.shrink = []; this.shrinkTimer = 0;
  }
  addPlayer(id, name) {
    const used = new Set(this.players.map((p) => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const p = { id, name, slot, color: COLORS[slot], score: 0, alive: false, x: 0, y: 0, dir: 'down', moving: false,
      maxBombs: 1, range: 2, speed: BASE_SPEED, kick: false, pierce: false, shield: false, ghost: 0, grace: 0, remote: false, input: { dx: 0, dy: 0, bomb: 0, det: 0 }, lastBomb: 0, lastDet: 0 };
    this.players.push(p);
    return p;
  }
  removePlayer(id) {
    const p = this.players.find((q) => q.id === id);
    if (!p) return;
    this.players = this.players.filter((q) => q !== p);
    this.bombs = this.bombs.filter((b) => b.owner !== id);
    if (this.phase !== 'lobby' && this.players.length < 2) { this.phase = 'lobby'; this.msg = ''; }
  }
  tile(x, y) { return (x < 0 || y < 0 || x >= W || y >= H) ? WALL : this.grid[y * W + x]; }
  setTile(x, y, v) { this.grid[y * W + x] = v; }
  bombAt(x, y) { return this.bombs.find((b) => b.x === x && b.y === y); }

  buildMap() {
    const g = this.grid;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = EMPTY;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0)) v = WALL;
      else if (Math.random() < 0.72) v = CRATE;
      g[y * W + x] = v;
    }
    // Startecken freiräumen
    for (const [sx, sy] of spawns()) {
      for (const [x, y] of [[sx, sy], [sx + 1, sy], [sx - 1, sy], [sx, sy + 1], [sx, sy - 1]]) if (g[y * W + x] === CRATE) g[y * W + x] = EMPTY;
    }
  }
  startMatch() {
    this.recorded = false;
    this.settings = cleanSettings(this.settings);
    this.rules = rulesFor(this.settings, this.players.length);
    const [w, h] = this.rules.dims;
    applySize(w, h);
    this.grid = new Array(W * H).fill(EMPTY);
    for (const p of this.players) p.score = 0;
    this.round = 0;
    this.startRound();
  }
  startRound() {
    this.round++;
    for (const p of this.players) p.waiting = false;
    if (this.rules.mode === 'klassisch') {
      // Klassisch: Feldgröße folgt der Zahl der Spieler, die gerade da sind
      this.rules = rulesFor(this.settings, this.players.length);
      const [w, h] = this.rules.dims;
      if (w !== W || h !== H) { applySize(w, h); this.grid = new Array(W * H).fill(EMPTY); }
    }
    this.buildMap();
    this.bombs = []; this.flames = []; this.items = [];
    this.players.forEach((p) => {
      const [x, y] = spawns()[p.slot];
      Object.assign(p, { x, y, alive: true, dir: 'down', moving: false, maxBombs: 1, range: 2, speed: BASE_SPEED, kick: false, pierce: false, shield: false, ghost: 0, grace: 0, remote: false });
      p.lastBomb = p.input.bomb; p.lastDet = p.input.det;
    });
    this.clock = 0; // zählt die Spielzeit der Runde hoch, es gibt kein Zeitlimit
    this.shrink = this.rules.variant === 'schrumpf' ? this.spiral() : [];
    this.shrinkTimer = 0;
    this.phase = 'play';
    this.phaseTimer = 1.2;
    this.msg = 'Runde ' + this.round;
  }

  // Reihenfolge der Felder von außen nach innen, im Uhrzeigersinn
  spiral() {
    const out = [];
    let x0 = 1, y0 = 1, x1 = W - 2, y1 = H - 2;
    while (x0 <= x1 && y0 <= y1) {
      for (let x = x0; x <= x1; x++) out.push([x, y0]);
      for (let y = y0 + 1; y <= y1; y++) out.push([x1, y]);
      if (y0 < y1) for (let x = x1 - 1; x >= x0; x--) out.push([x, y1]);
      if (x0 < x1) for (let y = y1 - 1; y > y0; y--) out.push([x0, y]);
      x0++; y0++; x1--; y1--;
    }
    // Die innersten 3 × 3 Felder bleiben frei, damit am Ende noch Platz ist
    const cx = (W - 1) / 2, cy = (H - 1) / 2;
    return out.filter(([x, y]) => Math.abs(x - cx) > 1 || Math.abs(y - cy) > 1);
  }
  dropBlock(x, y) {
    this.setTile(x, y, WALL);
    this.bombs = this.bombs.filter((b) => b.x !== x || b.y !== y);
    this.items = this.items.filter((i) => i.x !== x || i.y !== y);
    this.flames = this.flames.filter((f) => f.x !== x || f.y !== y);
    for (const p of this.players) if (p.alive && Math.abs(p.x - x) < 0.85 && Math.abs(p.y - y) < 0.85) p.alive = false;
  }

  // p (optional): Spieler, für den geprüft wird. Mit Geist-Item sind Kisten und Bomben kein Hindernis.
  blocked(x, y, p) {
    const t = this.tile(x, y);
    if (p && p.ghost > 0) return t === WALL;
    return t !== EMPTY || !!this.bombAt(x, y);
  }

  movePlayer(p, dt) {
    const hold = p.cornerHold || 0;
    p.cornerHold = 0;
    const { dx, dy } = p.input;
    p.moving = false;
    if (!dx && !dy) return;
    // Nur eine Richtung gleichzeitig; die zuletzt gedrückte gewinnt (Client sendet nur eine)
    p.dir = dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down';
    let dist = p.speed * dt;
    const horiz = dx !== 0;
    const d = horiz ? dx : dy;
    let along = horiz ? p.x : p.y;      // Achse der Bewegung
    let cross = horiz ? p.y : p.x;      // Querachse
    const startCross = cross;
    const cc = Math.round(cross);
    const off = cross - cc;
    const ca = Math.round(along);
    const cell = (a, c) => horiz ? [a, c] : [c, a];
    const blk = (a, c) => { const [x, y] = cell(a, c); return this.blocked(x, y, p); };

    // Kick: Bombe direkt vor uns anstoßen
    const [ax, ay] = cell(ca + d, cc);
    const b = this.bombAt(ax, ay);
    if (b && p.kick && !(p.ghost > 0) && !b.vx && !b.vy && Math.abs(off) < 0.3 && (along - ca) * d >= -0.05) {
      if (!this.blocked(ax + (horiz ? d : 0), ay + (horiz ? 0 : d))) { b.vx = horiz ? d : 0; b.vy = horiz ? 0 : d; b.slide = 0; }
    }

    const blockedAhead = blk(ca + d, cc);
    if (Math.abs(off) > 0.001) {
      if (blockedAhead && (along - ca) * d >= 0) {
        // Ecken-Hilfe: Vor uns ist zu, aber die Nachbarspur, zu der wir schon versetzt stehen, ist frei.
        // Dann rutschen wir seitlich hinüber und können sofort abbiegen.
        const n = cc + Math.sign(off);
        if (Math.abs(off) >= 0.1 && Math.abs(along - ca) < 0.02 && !blk(ca, n) && !blk(ca + d, n)) {
          along = ca;
          cross += Math.sign(off) * Math.min(dist, Math.abs(n - cross));
          this.setPos(p, horiz, along, cross, startCross);
        }
        return;
      }
      // Sonst zur Mitte der eigenen Spur rutschen
      const step = Math.min(dist, Math.abs(off));
      cross -= Math.sign(off) * step;
      dist -= step;
    } else if (blockedAhead && Math.abs(along - ca) < 0.02) {
      // Genau mittig vor einer Wand: ist nur eine Nachbarspur frei, dorthin ausweichen (wie um eine Ecke laufen)
      const opts = [-1, 1].filter((s2) => !blk(ca, cc + s2) && !blk(ca + d, cc + s2));
      p.cornerHold = hold + dt;
      if (opts.length === 1 && p.cornerHold > 0.12) {
        cross += opts[0] * Math.min(dist, 1);
        this.setPos(p, horiz, ca, cross, startCross);
        return;
      }
    }
    // Dann entlang der Bewegungsachse
    let na = along + d * dist;
    if (blk(ca + d, cc)) {
      if (d > 0) na = Math.min(na, ca); else na = Math.max(na, ca);
      if ((along - ca) * d > 0) na = along; // schon über die Mitte hinaus (z. B. auf eigener Bombe)
    }
    this.setPos(p, horiz, na, cross, startCross, along);
  }
  setPos(p, horiz, along, cross, startCross, startAlong) {
    const sa = startAlong === undefined ? (horiz ? p.x : p.y) : startAlong;
    p.moving = Math.abs(along - sa) > 1e-4 || Math.abs(cross - startCross) > 1e-4;
    if (horiz) { p.x = along; p.y = cross; } else { p.y = along; p.x = cross; }
  }

  placeBomb(p) {
    const x = Math.round(p.x), y = Math.round(p.y);
    if (this.tile(x, y) !== EMPTY || this.bombAt(x, y)) return;
    if (this.bombs.filter((b) => b.owner === p.id).length >= p.maxBombs) return;
    this.bombs.push({ x, y, owner: p.id, range: p.range, pierce: p.pierce, remote: p.remote, fuse: p.remote ? REMOTE_MAX : FUSE, vx: 0, vy: 0, slide: 0 });
  }

  explode(first) {
    const queue = [first];
    const born = this.time;
    while (queue.length) {
      const b = queue.shift();
      if (!this.bombs.includes(b)) continue;
      this.bombs = this.bombs.filter((q) => q !== b);
      this.addFlame(b.x, b.y, born);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let i = 1; i <= b.range; i++) {
          const x = b.x + dx * i, y = b.y + dy * i;
          const t = this.tile(x, y);
          if (t === WALL) break;
          if (t === CRATE) {
            this.setTile(x, y, EMPTY);
            this.addFlame(x, y, born);
            if (Math.random() * 100 < this.rules.items) this.items.push({ x, y, type: pickItem(this.rules), born: born + 1e-6 });
            if (b.pierce) continue; // Durchschlag: Feuer geht durch Kisten hindurch
            break;
          }
          this.addFlame(x, y, born);
          const other = this.bombAt(x, y);
          if (other) { queue.push(other); break; }
          const item = this.items.findIndex((it) => it.x === x && it.y === y && it.born < born);
          if (item >= 0) { this.items.splice(item, 1); break; }
        }
      }
    }
  }
  addFlame(x, y, born) {
    const f = this.flames.find((q) => q.x === x && q.y === y);
    if (f) f.t = FLAME_TIME; else this.flames.push({ x, y, t: FLAME_TIME, born });
  }

  step(dt) {
    this.time += dt;
    if (this.phase === 'lobby' || this.phase === 'matchEnd') return;
    if (this.phase === 'roundEnd') {
      this.phaseTimer -= dt;
      this.flames.forEach((f) => (f.t -= dt)); this.flames = this.flames.filter((f) => f.t > 0);
      if (this.phaseTimer <= 0) this.startRound();
      return;
    }
    // play
    if (this.phaseTimer > 0) { this.phaseTimer -= dt; if (this.phaseTimer <= 0) this.msg = ''; }
    const before = this.clock;
    this.clock += dt;
    if (this.shrink.length && this.clock >= SHRINK_AT) {
      if (before < SHRINK_AT) { this.msg = 'Das Feld schrumpft!'; this.phaseTimer = 1.5; }
      const every = SHRINK_DUR / (this.spiral().length || 1);
      this.shrinkTimer -= dt;
      while (this.shrinkTimer <= 0 && this.shrink.length) {
        this.shrinkTimer += every;
        const [x, y] = this.shrink.shift();
        this.dropBlock(x, y);
      }
    }

    for (const p of this.players) {
      if (!p.alive) { p.lastBomb = p.input.bomb; p.lastDet = p.input.det; continue; }
      if (p.ghost > 0) p.ghost = Math.max(0, p.ghost - dt);
      if (p.grace > 0) p.grace = Math.max(0, p.grace - dt);
      this.movePlayer(p, dt);
      if (p.input.bomb !== p.lastBomb) { p.lastBomb = p.input.bomb; this.placeBomb(p); }
      if (p.input.det !== p.lastDet) {
        // Fernzünder (Strg): die älteste eigene Fernzünder-Bombe sofort zünden
        p.lastDet = p.input.det;
        const rb = this.bombs.find((b) => b.owner === p.id && b.remote);
        if (rb) this.explode(rb);
      }
      // Power-ups einsammeln
      const px = Math.round(p.x), py = Math.round(p.y);
      const i = this.items.findIndex((it) => it.x === px && it.y === py);
      if (i >= 0) {
        const it = this.items.splice(i, 1)[0];
        if (it.type === 'bomb') p.maxBombs = Math.min(8, p.maxBombs + 1);
        if (it.type === 'fire') p.range = Math.min(10, p.range + 1);
        if (it.type === 'speed') p.speed = Math.min(MAX_SPEED, p.speed + SPEED_STEP);
        if (it.type === 'kick') p.kick = true;
        if (it.type === 'mega') { p.range = 10; p.maxBombs = Math.min(8, p.maxBombs + 1); }
        if (it.type === 'pierce') p.pierce = true;
        if (it.type === 'shield') p.shield = true;
        if (it.type === 'ghost') p.ghost = GHOST_TIME;
        if (it.type === 'remote') p.remote = true;
      }
    }

    // Gekickte Bomben rollen
    for (const b of this.bombs) {
      if (!b.vx && !b.vy) continue;
      b.slide += dt * KICK_SPEED;
      while (b.slide >= 1 && (b.vx || b.vy)) {
        b.slide -= 1;
        const nx = b.x + b.vx, ny = b.y + b.vy;
        const hitPlayer = this.players.some((p) => p.alive && Math.round(p.x) === nx && Math.round(p.y) === ny);
        const hitItem = this.items.some((it) => it.x === nx && it.y === ny);
        if (this.blocked(nx, ny) || hitPlayer || hitItem) { b.vx = b.vy = 0; b.slide = 0; }
        else { b.x = nx; b.y = ny; }
      }
    }

    // Zünder
    for (const b of [...this.bombs]) {
      b.fuse -= dt;
      if (b.fuse <= 0) this.explode(b);
    }
    // Bomben, die ins Feuer rollen
    for (const b of [...this.bombs]) if (this.flames.some((f) => f.x === b.x && f.y === b.y)) this.explode(b);

    // Feuer
    for (const f of this.flames) {
      f.t -= dt;
      const i = this.items.findIndex((it) => it.x === f.x && it.y === f.y && it.born < f.born);
      if (i >= 0) this.items.splice(i, 1);
    }
    this.flames = this.flames.filter((f) => f.t > 0);
    for (const p of this.players) {
      if (!p.alive) continue;
      const px = Math.round(p.x), py = Math.round(p.y);
      if (p.grace > 0) continue;
      if (this.flames.some((f) => f.x === px && f.y === py)) {
        if (p.shield) { p.shield = false; p.grace = SHIELD_GRACE; } else p.alive = false;
      }
    }
    this.checkRoundEnd(false);
  }

  checkRoundEnd(force) {
    if (this.phase !== 'play') return;
    const alive = this.players.filter((p) => p.alive);
    const solo = this.players.filter((p) => !p.waiting).length === 1;
    const over = force || (solo ? alive.length === 0 : alive.length <= 1);
    if (!over) return;
    if (alive.length === 1 && !solo) {
      // Kein Matchende mehr: Es wird endlos weitergespielt, jeder Rundensieg zählt in der Rangliste.
      const w = alive[0]; w.score++;
      this.winSeq = (this.winSeq || 0) + 1; this.lastWinner = w.name;
      this.msg = w.name + ' gewinnt die Runde';
    } else this.msg = solo ? 'Erwischt!' : 'Unentschieden';
    this.phase = 'roundEnd';
    this.phaseTimer = 3;
  }

  snapshot() {
    return {
      t: 'state', w: W, h: H, wins: this.rules.wins, variant: this.rules.variant, phase: this.phase, round: this.round, msg: this.msg, clock: Math.max(0, Math.ceil(this.clock)),
      grid: this.grid.join(''),
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive,
        x: +p.x.toFixed(3), y: +p.y.toFixed(3), dir: p.dir, moving: p.moving, bombs: p.maxBombs, range: p.range,
        speed: Math.round((p.speed - BASE_SPEED) / SPEED_STEP), kick: p.kick,
        pierce: p.pierce, shield: p.shield, ghost: Math.ceil(p.ghost), grace: p.grace > 0, remote: p.remote, waiting: !!p.waiting })),
      bombs: this.bombs.map((b) => [b.x, b.y, +b.fuse.toFixed(2), b.remote ? 1 : 0]),
      flames: this.flames.map((f) => [f.x, f.y]),
      items: this.items.map((i) => [i.x, i.y, i.type]),
    };
  }
}

// ---------- Rangliste ----------
// Jeder Rundensieg wird als Eintrag gespeichert (im Browser, localStorage). Ältere Einträge stammen
// noch aus ganzen Spielen; dort zählen die gewonnenen Runden (score) genauso als Siege.
// Beim Beitreten tauschen Gastgeber und Mitspieler ihre Listen aus, so haben alle denselben Stand.
const RANK_KEY = 'ff-matches', RANK_MAX = 300;
function loadMatches() {
  try { const l = JSON.parse(localStorage.getItem(RANK_KEY) || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}
function cleanMatch(m) {
  if (!m || typeof m.id !== 'string' || !Array.isArray(m.players) || m.players.length < 2 || m.players.length > MAX_PLAYERS) return null;
  const players = m.players.map((p) => ({ name: String(p && p.name || '').slice(0, 12), score: Math.max(0, Math.min(MAX_WINS, p && p.score | 0)) }));
  if (players.some((p) => !p.name)) return null;
  const winner = String(m.winner || '').slice(0, 12);
  if (!players.some((p) => p.name === winner)) return null;
  return { id: m.id.slice(0, 40), date: +m.date || 0, players, winner };
}
function mergeMatches(list) {
  if (!Array.isArray(list)) return false;
  const all = loadMatches(); const ids = new Set(all.map((m) => m.id));
  let added = false;
  for (const raw of list.slice(-RANK_MAX)) {
    const m = cleanMatch(raw);
    if (m && !ids.has(m.id)) { all.push(m); ids.add(m.id); added = true; }
  }
  if (added) {
    all.sort((a, b) => a.date - b.date);
    try { localStorage.setItem(RANK_KEY, JSON.stringify(all.slice(-RANK_MAX))); } catch (e) {}
    renderRanking();
  }
  return added;
}
function ranking() {
  const by = new Map();
  for (const m of loadMatches()) for (const p of m.players) {
    const key = p.name.trim().toLowerCase();
    const r = by.get(key) || { name: p.name, wins: 0, last: 0 };
    r.wins += p.score;
    if (m.date >= r.last) { r.last = m.date; r.name = p.name; }
    by.set(key, r);
  }
  return [...by.values()].sort((a, b) => b.wins - a.wins || b.last - a.last || a.name.localeCompare(b.name));
}
function renderRanking() {
  const rows = ranking();
  const html = rows.length
    ? '<table><thead><tr><th>#</th><th>Name</th><th title="Gewonnene Runden insgesamt">Siege</th></tr></thead><tbody>' +
      rows.slice(0, 20).map((r, i) => `<tr><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td>${esc(r.name)}</td><td>${r.wins}</td></tr>`).join('') +
      '</tbody></table>'
    : '<p class="muted">Noch keine Siege. Nach der ersten gewonnenen Runde steht hier, wer vorne liegt.</p>';
  document.querySelectorAll('.ranking').forEach((el) => { el.innerHTML = html; });
}
function recordWin(g) {
  const winner = g.players.find((p) => p.name === g.lastWinner);
  if (!winner || g.players.length < 2) return;
  const m = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), date: Date.now(),
    players: g.players.map((p) => ({ name: p.name, score: p === winner ? 1 : 0 })), winner: winner.name };
  mergeMatches([m]);
  renderRanking();
  const msg = { t: 'matches', list: loadMatches() };
  for (const c of S.conns.values()) c.send(msg);
}

// ---------- App-Zustand ----------
const S = {
  role: null,        // 'host' | 'client'
  room: '', myId: null,
  game: null, hostNet: null, conns: new Map(), pwHash: '',
  conn: null,        // Verbindung des Clients zum Gastgeber
  view: null,        // zuletzt empfangener / berechneter Spielstand
  disp: new Map(),   // geglättete Positionen für die Anzeige
  input: { dx: 0, dy: 0, bomb: 0, det: 0 },
  lastSent: '',
};

// ---------- Chat ----------
// Nachrichten laufen über den Gastgeber: Mitspieler schicken {t:'chat', text}, der Gastgeber setzt Name und
// Farbe des Absenders dazu und verteilt die Nachricht an alle. Gespeichert wird nichts, nur die letzten
// Nachrichten der laufenden Sitzung (neue Mitspieler bekommen die letzten 20).
function cleanName(n) { return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'Spieler'; }
// Namen ändern: läuft wie der Chat über den Gastgeber, der den neuen Namen an alle verteilt
function renamePlayer(id, name) {
  const p = S.game.players.find((q) => q.id === id);
  if (!p) return;
  name = cleanName(name);
  if (name === p.name) return;
  p.name = name;
  broadcastLobby();
  if (S.game.phase !== 'lobby') { const snap = S.game.snapshot(); for (const c of S.conns.values()) c.send(snap); S.view = snap; }
}
function changeMyName(name) {
  name = cleanName(name);
  $('in-name').value = name; $('my-name').value = name;
  try { localStorage.setItem('ff-name', name); } catch (e) {}
  if (S.role === 'host') renamePlayer('host', name);
  else if (S.conn) S.conn.send({ t: 'rename', name });
}
function askName() {
  const me = S.view && S.view.players && S.view.players.find((p) => p.id === S.myId);
  const n = prompt('Dein Name (höchstens 12 Zeichen):', me ? me.name : $('in-name').value);
  if (n !== null && n.trim()) changeMyName(n);
}
function hostChat(p, text) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!text) return;
  const m = { t: 'chat', id: p.id, name: p.name, color: p.color, text, ts: Date.now() };
  for (const c of S.conns.values()) c.send(m);
  Chat.add(m);
}
const Chat = {
  log: [], unread: 0, open: false, screen: '',
  popups: (() => { try { return localStorage.getItem('ff-chat-popup') !== 'aus'; } catch (e) { return true; } })(),
  mobile: () => matchMedia('(max-width: 860px)').matches,
  visible() { return !$('chat').classList.contains('hidden') && (!Chat.mobile() || Chat.open); },
  line(m) {
    const mine = m.id === S.myId;
    return `<li class="${mine ? 'mine' : ''}"><span class="dot" style="background:${esc(m.color || '#888')}"></span><b>${esc(m.name)}</b> ${esc(m.text)}</li>`;
  },
  render() {
    const el = $('chat-log');
    el.innerHTML = Chat.log.length ? Chat.log.map(Chat.line).join('') : '<li class="muted">Noch keine Nachrichten. Sag Hallo!</li>';
    el.scrollTop = el.scrollHeight;
  },
  reset(list) { Chat.log = Array.isArray(list) ? list.slice(-50) : []; Chat.unread = 0; Chat.badge(); Chat.render(); },
  add(m) {
    if (!m || !m.text) return;
    Chat.log.push(m); if (Chat.log.length > 50) Chat.log.shift();
    Chat.render();
    if (m.id === S.myId) return;
    Sound.play && Sound.play('chat');
    if (!Chat.visible()) { Chat.unread++; Chat.badge(); }
    if (Chat.popups && (inGame() || !Chat.visible())) Chat.toast(m);
  },
  toast(m) {
    const box = $('chat-toasts'), t = document.createElement('div');
    t.className = 'chat-toast'; t.innerHTML = `<span class="dot" style="background:${esc(m.color || '#888')}"></span><b>${esc(m.name)}</b> ${esc(m.text)}`;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 4000);
    setTimeout(() => t.remove(), 4600);
  },
  badge() { const b = $('chat-badge'); b.textContent = Chat.unread > 9 ? '9+' : Chat.unread; b.classList.toggle('hidden', !Chat.unread); },
  setOpen(v) {
    Chat.open = v; document.body.classList.toggle('chat-open', v);
    if (v) { Chat.unread = 0; Chat.badge(); Chat.render(); }
  },
  place(screen) {
    const on = screen === 'lobby' || screen === 'game';
    // Auf dem Handy startet der Chat bei jedem Betreten eines Raums aufgeklappt.
    const wasOn = Chat.screen === 'lobby' || Chat.screen === 'game';
    Chat.screen = screen;
    if (on && !wasOn && Chat.mobile()) Chat.setOpen(true);
    $('chat').classList.toggle('hidden', !on);
    $('chat-toggle').classList.toggle('hidden', !on);
    if (!on) { Chat.setOpen(false); return; }
    $('chat-slot-' + screen).appendChild($('chat'));
    Chat.render();
  },
  send(text) {
    text = String(text || '').trim(); if (!text) return;
    if (S.role === 'host') { const p = S.game.players.find((q) => q.id === 'host'); if (p) hostChat(p, text); }
    else if (S.conn) S.conn.send({ t: 'chat', text: text.slice(0, 200) });
  },
};

// Handy im Spiel: Tasten/Wischen und Chat-Knopf wandern oben rechts in die Titelzeile,
// Steuerungs-Erklärung und Rangliste starten eingeklappt. Am PC bleibt alles, wie es ist.
let mobileArranged = false, homes = null;
function arrangeMobile(game, entering) {
  const on = game && Chat.mobile(), tools = $('head-tools'), pick = document.querySelector('.ctl-pick');
  if (on && !mobileArranged) {
    const home = (el) => ({ el, parent: el.parentNode, next: el.nextSibling });
    homes = homes || [home($('chat-toggle')), home($('btn-mute')), home($('btn-quit'))];
    // Verlassen als ✕ ganz links vor dem Titel, Ton als Symbol links neben der Steuerungswahl
    document.querySelector('header').prepend($('btn-quit'));
    tools.append($('btn-mute'), pick, $('chat-toggle'));
    const host = S.role === 'host', q = $('btn-quit');
    q.title = host ? 'Zurück zur Lobby' : 'Raum verlassen'; q.setAttribute('aria-label', q.title);
    $('ctl-help').open = false; $('rank-fold').open = false;
  } else if (!on && mobileArranged) {
    $('ctl-help').before(pick);
    for (const h of homes) h.parent.insertBefore(h.el, h.next);
    $('btn-quit').title = 'Verlassen'; $('btn-quit').setAttribute('aria-label', 'Verlassen');
  }
  if (!on) $('rank-fold').open = true;
  else if (entering) { $('ctl-help').open = false; $('rank-fold').open = false; scrollTo(0, 0); fitHeightSoon(); }
  mobileArranged = on;
}
matchMedia('(max-width: 860px)').addEventListener('change', () => arrangeMobile(inGame()));
// Echte sichtbare Höhe (Android meldet 100dvh nach dem Laden oft falsch, bis die App gewechselt wird)
function fitHeight() {
  const h = Math.round((window.visualViewport && visualViewport.height) || innerHeight);
  if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
}
function fitHeightSoon() { fitHeight(); requestAnimationFrame(fitHeight); setTimeout(fitHeight, 150); setTimeout(fitHeight, 500); setTimeout(fitHeight, 1200); }
addEventListener('resize', fitHeight);
addEventListener('orientationchange', fitHeightSoon);
addEventListener('pageshow', fitHeightSoon);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fitHeightSoon(); });
if (window.visualViewport) visualViewport.addEventListener('resize', fitHeight);
fitHeight();

// ---------- Oberfläche ----------
function show(screen) {
  for (const s of ['start', 'lobby', 'game']) $('screen-' + s).classList.toggle('hidden', s !== screen);
  $('rank-start').classList.toggle('hidden', screen !== 'start');
  $('tech-start').classList.toggle('hidden', screen !== 'start');
  document.body.classList.toggle('ingame', screen === 'game');
  Chat.place(screen);
  arrangeMobile(screen === 'game', true);
  renderRanking();
}
function startMsg(text, err) { const m = $('start-msg'); m.textContent = text; m.classList.toggle('err', !!err); }

function readForm() {
  const name = $('in-name').value.trim() || 'Spieler';
  const roomRaw = $('in-room').value.trim();
  const pw = $('in-pass').value;
  try { localStorage.setItem('ff-name', name); localStorage.setItem('ff-room', roomRaw); localStorage.setItem('ff-pass', pw); } catch (e) {}
  if (!slug(roomRaw)) { startMsg('Bitte einen Raumnamen eingeben.', true); return null; }
  if (!pw) { startMsg('Bitte ein Passwort eingeben.', true); return null; }
  return { name: name.slice(0, 12), room: slug(roomRaw), roomName: roomRaw.slice(0, 24), pw };
}
function setBusy(b) { $('btn-host').disabled = b; $('btn-join').disabled = b; }

async function hostRoom() {
  const f = readForm(); if (!f) return;
  setBusy(true); startMsg('Raum wird erstellt …');
  try {
    S.role = 'host'; S.room = f.room; S.roomName = f.roomName; S.pw = f.pw; S.pwHash = await hashPw(f.room, f.pw);
    S.game = new Game();
    S.myId = 'host';
    S.game.addPlayer('host', f.name);
    S.game.settings = loadSavedSettings();
    S.hostNet = await Net.host(f.room, onClientConnect);
    startMsg('');
    enterLobby();
    runHostLoop();
  } catch (e) { S.role = null; startMsg(e.message, true); }
  setBusy(false);
}

function onClientConnect(conn) {
  let pid = null;
  const timeout = setTimeout(() => { if (!pid) conn.close(); }, 10000);
  conn.onData = (m) => {
    if (!m || typeof m !== 'object') return;
    if (!pid) {
      if (m.t !== 'join') return;
      clearTimeout(timeout);
      const g = S.game;
      let reason = null;
      if (m.pw !== S.pwHash) reason = 'Falsches Passwort.';
      else if (g.players.length >= MAX_PLAYERS) reason = `Der Raum ist voll (höchstens ${MAX_PLAYERS} Spieler).`;
      if (reason) { conn.send({ t: 'reject', reason }); setTimeout(() => conn.close(), 300); return; }
      pid = 'p' + Math.random().toString(36).slice(2, 8);
      const np = g.addPlayer(pid, cleanName(m.name));
      // Läuft schon ein Spiel? Dann schaut der Neue zu und spielt ab der nächsten Runde mit.
      if (g.phase !== 'lobby') np.waiting = true;
      S.conns.set(pid, conn);
      conn.send({ t: 'welcome', id: pid });
      conn.send({ t: 'chatlog', list: Chat.log.slice(-20) });
      if (mergeMatches(m.matches)) { const msg = { t: 'matches', list: loadMatches() }; for (const c of S.conns.values()) c.send(msg); }
      else conn.send({ t: 'matches', list: loadMatches() });
      broadcastLobby();
      return;
    }
    if (m.t === 'rename') { renamePlayer(pid, m.name); return; }
    if (m.t === 'chat') {
      const p = S.game.players.find((q) => q.id === pid);
      if (p) hostChat(p, m.text);
      return;
    }
    if (m.t === 'input') {
      const p = S.game.players.find((q) => q.id === pid);
      if (p) p.input = { dx: Math.sign(m.dx) | 0, dy: Math.sign(m.dy) | 0, bomb: m.bomb | 0, det: m.det | 0 };
    }
  };
  conn.onClose = () => {
    if (!pid) return;
    S.conns.delete(pid);
    S.game.removePlayer(pid);
    pid = null;
    broadcastLobby();
    if (S.game.phase === 'lobby' && inGame()) enterLobby();
  };
}

function broadcastLobby() {
  const msg = { t: 'lobby', players: S.game.players.map((p) => ({ id: p.id, name: p.name, color: p.color })), phase: S.game.phase, settings: S.game.settings, roomName: S.roomName };
  for (const c of S.conns.values()) c.send(msg);
  renderLobby(msg);
}

async function joinRoom() {
  const f = readForm(); if (!f) return;
  setBusy(true); startMsg('Verbinde mit dem Raum …');
  try {
    const conn = await Net.join(f.room);
    S.role = 'client'; S.room = f.room; S.roomName = f.roomName; S.pw = f.pw; S.conn = conn;
    const pw = await hashPw(f.room, f.pw);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Keine Antwort vom Gastgeber.')), 10000);
      conn.onData = (m) => {
        if (m.t === 'welcome') { clearTimeout(timer); S.myId = m.id; resolve(); }
        else if (m.t === 'reject') { clearTimeout(timer); reject(new Error(m.reason)); }
      };
      conn.onClose = () => { clearTimeout(timer); reject(new Error('Verbindung getrennt.')); };
      conn.send({ t: 'join', name: f.name, pw, matches: loadMatches() });
    });
    conn.onData = onHostMessage;
    conn.onClose = () => { if (S.role === 'client') leave('Der Gastgeber hat das Spiel verlassen.'); };
    startMsg('');
    enterLobby();
    runClientLoop();
  } catch (e) {
    if (S.conn) S.conn.close();
    S.role = null; S.conn = null;
    startMsg(e.message, true);
  }
  setBusy(false);
}

function onHostMessage(m) {
  if (m.t === 'lobby') {
    renderLobby(m);
    if (m.phase === 'lobby' && !$('screen-game').classList.contains('hidden')) enterLobby();
  } else if (m.t === 'matches') {
    mergeMatches(m.list); renderRanking();
  } else if (m.t === 'chat') {
    Chat.add(m);
  } else if (m.t === 'chatlog') {
    Chat.reset(m.list);
  } else if (m.t === 'state') {
    S.view = m;
    if (m.phase !== 'lobby' && $('screen-game').classList.contains('hidden')) show('game');
  }
}

function enterLobby() {
  show('lobby');
  $('lobby-room').textContent = '„' + (S.roomName || S.room) + '“';
  updateInvite();
  if (S.role === 'host') broadcastLobby();
}

// ---------- Einladungslink ----------
// Raum (und auf Wunsch Passwort) stehen hinter dem #. Dieser Teil der Adresse wird nie an einen Server geschickt.
function pwToHex(pw) { return [...new TextEncoder().encode(pw)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function hexToPw(hex) {
  hex = (hex || '').toLowerCase();
  if (!/^([0-9a-f]{2})+$/.test(hex)) return '';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)))); } catch (e) { return ''; }
}
function inviteLink() {
  // Raumname so, wie er eingegeben wurde (Großbuchstaben bleiben); die Raum-Kennung dahinter ist immer klein geschrieben
  const p = new URLSearchParams({ raum: S.roomName || S.room });
  // Passwort als Hex-Code: übersteht auch Apps, die den Link in Kleinbuchstaben umwandeln (Großbuchstaben bleiben erhalten)
  if ($('inv-pw').checked && S.pw) p.set('pwx', pwToHex(S.pw));
  return location.origin + location.pathname + (LOCAL ? '?local' : '') + '#' + p.toString();
}
function updateInvite() {
  $('inv-link').value = inviteLink();
  $('inv-msg').textContent = $('inv-pw').checked
    ? 'Der Link enthält das Passwort. Schick ihn nur an deine Mitspieler. Wer ihn öffnet, gibt nur noch einen Namen ein.'
    : 'Ohne Passwort im Link: Sag deinen Mitspielern das Passwort separat.';
}
async function copyInvite() {
  const link = inviteLink(), btn = $('btn-copy');
  let ok = false;
  try { await navigator.clipboard.writeText(link); ok = true; } catch (e) {
    const el = $('inv-link'); el.focus(); el.select();
    try { ok = document.execCommand('copy'); } catch (e2) {}
  }
  btn.textContent = ok ? 'Kopiert ✓' : 'Bitte markieren & kopieren';
  clearTimeout(copyInvite.t); copyInvite.t = setTimeout(() => { btn.textContent = 'Kopieren'; }, 2000);
}
$('inv-pw').addEventListener('change', updateInvite);
$('btn-copy').addEventListener('click', copyInvite);
$('inv-link').addEventListener('focus', (e) => e.target.select());
if (navigator.share) {
  $('btn-share').classList.remove('hidden');
  $('btn-share').addEventListener('click', () => {
    navigator.share({ title: 'BombRe', text: 'Spiel mit mir BombRe, Raum „' + (S.roomName || S.room) + '“:', url: inviteLink() }).catch(() => {});
  });
}
function renderSettings(st, isHost) {
  st = cleanSettings(st);
  const form = $('settings');
  for (const el of form.querySelectorAll('select, input')) {
    el.disabled = !isHost;
    if (document.activeElement === el) continue;
    if (el.type === 'radio') { el.checked = el.value === st[el.name]; continue; }
    el.value = String(el.name.startsWith('w_') ? st.megaW[el.name.slice(2)] : st[el.name]);
  }
  const classic = st.mode === 'klassisch';
  $('set-indiv').classList.toggle('hidden', classic);
  // Zünder-Knopf nur im Modus Individuell (bei Klassisch gibt es keine Mega-Items)
  document.body.classList.toggle('mode-klassisch', classic);
  $('mode-note').textContent = classic
    ? 'Klassische Regeln: 30 % Power-ups, keine Mega-Items. Das Feld wächst mit der Zahl der Spieler (bis 6). Es wird endlos weitergespielt.'
    : 'Alles selbst einstellen: Variante, Feldgröße, Power-ups und Mega-Items. Es wird endlos weitergespielt.';
  $('set-items-val').textContent = st.items + ' %';
  $('set-mega-val').textContent = st.mega + ' %';
  // Wie viel Prozent aller Power-ups ergibt das je Mega-Item?
  const sum = MEGA_LIST.reduce((a, t) => a + st.megaW[t], 0);
  for (const t of MEGA_LIST) {
    const share = sum ? st.mega * st.megaW[t] / sum : 0;
    $('w-' + t).textContent = st.megaW[t] ? `Gewicht ${st.megaW[t]} · ≈ ${share < 1 && share > 0 ? share.toFixed(1) : Math.round(share)} % der Power-ups` : 'aus';
  }
  $('settings-note').textContent = isHost ? 'Nur du als Gastgeber kannst das ändern.' : 'Der Gastgeber legt die Einstellungen fest.';
}
function readSettings() {
  const f = $('settings');
  return cleanSettings({ mode: f.querySelector('input[name=mode]:checked').value, variant: f.variant.value, size: f.size.value, items: f.items.value, wins: WIN_ROUNDS, mega: f.mega.value,
    megaW: Object.fromEntries(MEGA_LIST.map((t) => [t, f['w_' + t].value])) });
}
function loadSavedSettings() {
  try { return cleanSettings(JSON.parse(localStorage.getItem('ff-settings') || 'null') || DEFAULT_SETTINGS); } catch (e) { return { ...DEFAULT_SETTINGS }; }
}

function renderLobby(m) {
  const me = m.players.find((p) => p.id === S.myId);
  if (me && document.activeElement !== $('my-name')) $('my-name').value = me.name;
  // Mitspieler sehen den Raumnamen so, wie der Gastgeber ihn geschrieben hat
  if (m.roomName && slug(m.roomName) === S.room) { S.roomName = m.roomName; $('lobby-room').textContent = '„' + S.roomName + '“'; if ($('inv-link')) updateInvite(); }
  $('lobby-players').innerHTML = m.players.map((p) =>
    `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.id === 'host' ? ' <small>(Gastgeber)</small>' : ''}${p.id === S.myId ? ' <small>– du</small>' : ''}</li>`).join('');
  const isHost = S.role === 'host';
  $('btn-start').classList.toggle('hidden', !isHost);
  renderSettings(m.settings, isHost);
  $('lobby-hint').textContent = isHost
    ? (m.players.length < 2 ? 'Warte auf Mitspieler. Schick ihnen den Einladungslink oben. (Allein starten geht zum Ausprobieren.)' : m.players.length + ' von höchstens ' + MAX_PLAYERS + ' Spielern sind da. Wer später kommt, steigt zur nächsten Runde ein.')
    : 'Warte, bis der Gastgeber das Spiel startet …';
}

function leave(reason) {
  if (S.role === 'host') {
    for (const c of S.conns.values()) c.close();
    S.hostNet && S.hostNet.close();
  } else if (S.conn) {
    const c = S.conn; S.conn = null; S.role = null; c.close();
  }
  Object.assign(S, { role: null, game: null, hostNet: null, conns: new Map(), conn: null, view: null, myId: null });
  S.disp.clear();
  Chat.reset([]);
  show('start');
  startMsg(reason || '', !!reason);
}

// ---------- Schleifen ----------
let loopId = 0;
function runHostLoop() {
  const id = ++loopId;
  let last = performance.now(), acc = 0, n = 0;
  const tick = (now) => {
    acc += Math.min(0.25, (now - last) / 1000); last = now;
    const g = S.game;
    const me = g.players.find((p) => p.id === 'host'); if (me) me.input = { ...S.input };
    while (acc >= TICK) {
      g.step(TICK); acc -= TICK;
      if ((g.winSeq || 0) !== (g.recordedSeq || 0)) { g.recordedSeq = g.winSeq; recordWin(g); }
      if (++n % SEND_EVERY === 0) {
        const snap = g.snapshot();
        for (const c of S.conns.values()) c.send(snap);
      }
    }
  };
  const frame = (now) => {
    if (id !== loopId || S.role !== 'host') return;
    tick(now);
    S.view = S.game.snapshot();
    draw(S.view, true);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Weiterrechnen, wenn der Tab im Hintergrund ist (requestAnimationFrame pausiert dann)
  const bg = setInterval(() => {
    if (id !== loopId || S.role !== 'host') return clearInterval(bg);
    if (document.hidden) tick(performance.now());
  }, 50);
}
function runClientLoop() {
  const id = ++loopId;
  const frame = () => {
    if (id !== loopId || S.role !== 'client') return;
    const key = S.input.dx + ',' + S.input.dy + ',' + S.input.bomb + ',' + S.input.det;
    if (key !== S.lastSent) { S.lastSent = key; S.conn.send({ t: 'input', ...S.input }); }
    if (S.view) draw(S.view, false);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Eingaben regelmäßig wiederholen, falls eine Nachricht verloren geht
  const iv = setInterval(() => {
    if (id !== loopId || S.role !== 'client') return clearInterval(iv);
    S.conn && S.conn.send({ t: 'input', ...S.input });
  }, 250);
}

// ---------- Eingabe ----------
const held = []; // gedrückte Richtungen, letzte zuerst
let swipeDir = null; // Richtung beim Wischen (Handysteuerung „Wischen“)
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
function press(dir) { if (!held.includes(dir)) held.unshift(dir); updateDir(); }
function release(dir) { const i = held.indexOf(dir); if (i >= 0) held.splice(i, 1); updateDir(); }
function updateDir() { const d = held[0] || swipeDir; [S.input.dx, S.input.dy] = d ? DIRS[d] : [0, 0]; }
function bomb() { S.input.bomb = (S.input.bomb + 1) % 1000; }
function detonate() { S.input.det = (S.input.det + 1) % 1000; }
function inGame() { return !$('screen-game').classList.contains('hidden'); }

addEventListener('keydown', (e) => {
  if (!inGame() || (e.target && e.target.closest && e.target.closest('input, textarea'))) return;
  const d = KEYMAP[e.code];
  if (d) { press(d); e.preventDefault(); }
  else if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { bomb(); e.preventDefault(); }
  else if ((e.code === 'ControlLeft' || e.code === 'ControlRight') && !e.repeat) { detonate(); e.preventDefault(); }
});
addEventListener('keyup', (e) => { const d = KEYMAP[e.code]; if (d) release(d); });
addEventListener('blur', () => { held.length = 0; updateDir(); });
document.querySelectorAll('#touch [data-dir]').forEach((btn) => {
  const d = btn.dataset.dir;
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); press(d); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, () => release(d));
});
$('touch-bomb').addEventListener('pointerdown', (e) => { e.preventDefault(); bomb(); });
$('touch-det').addEventListener('pointerdown', (e) => { e.preventDefault(); detonate(); });

// ---------- Handysteuerung: Tasten oder Wischen (gilt nur für dieses Gerät) ----------
// Wischen: Finger auflegen und in die gewünschte Richtung ziehen. Solange der Finger liegt,
// läuft die Figur weiter.
const SWIPE_MIN = 18;
let ctlMode = 'tasten';
// Ohne eigene Wahl: auf Handys (Touch-Bildschirm) ist Wischen voreingestellt, sonst Tasten.
// Gespeichert wird nur, was jemand selbst anklickt (Schlüssel ff-steuerung; das alte ff-ctl wurde
// schon beim bloßen Laden geschrieben und taugt deshalb nicht als echte Wahl).
try {
  const saved = localStorage.getItem('ff-steuerung');
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && (saved === 'wischen' || !saved)) ctlMode = 'wischen';
} catch (e) {}
function setCtl(mode, save) {
  ctlMode = mode === 'wischen' ? 'wischen' : 'tasten';
  if (save) try { localStorage.setItem('ff-steuerung', ctlMode); } catch (e) {}
  document.querySelectorAll('input[name=ctl]').forEach((r) => { r.checked = r.value === ctlMode; });
  document.body.classList.toggle('ctl-wischen', ctlMode === 'wischen');
  $('ctl-note').textContent = ctlMode === 'wischen'
    ? 'Irgendwo auf dem Bildschirm in eine Richtung wischen und den Finger liegen lassen, um zu laufen. Bomben legst du mit dem 💣-Knopf.'
    : 'Steuerkreuz und Bombenknopf unter dem Spielfeld.';
  swipeDir = null; updateDir();
}
document.querySelectorAll('input[name=ctl]').forEach((r) => r.addEventListener('change', () => setCtl(r.value, true)));
setCtl(ctlMode);
// Wischen funktioniert im Spiel überall auf dem Bildschirm, außer auf Knöpfen, Eingabefeldern, dem Chat
// und der Rangliste. Tippen legt keine Bombe mehr, dafür gibt es den 💣-Knopf.
(function swipe() {
  const SKIP = 'button, input, select, textarea, label, summary, a, .hud-p.me, .chat, .chat-toggle, .help-bubble, .ranking, .leave-row, .update-bar';
  let sw = null;
  document.addEventListener('pointerdown', (e) => {
    if (ctlMode !== 'wischen' || sw || !inGame() || e.pointerType === 'mouse') return;
    if (e.target.closest(SKIP)) return;
    e.preventDefault();
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    sw = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  document.addEventListener('pointermove', (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y, len = Math.hypot(dx, dy);
    if (len < SWIPE_MIN) return;
    const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (d !== swipeDir) { swipeDir = d; updateDir(); }
    // Ankerpunkt mitziehen, damit ein Richtungswechsel sofort greift
    sw.x = e.clientX - dx / len * SWIPE_MIN; sw.y = e.clientY - dy / len * SWIPE_MIN;
  });
  const end = (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    sw = null; swipeDir = null; updateDir();
  };
  for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, end);
})();

$('btn-host').onclick = hostRoom;
$('btn-join').onclick = joinRoom;
$('in-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('btn-leave').onclick = () => leave();
// Auf dem Handy ist der Knopf das ✕ oben links: Der Gastgeber holt damit alle zurück in die Lobby,
// Mitspieler verlassen den Raum (sie können die Lobby nicht allein öffnen).
$('btn-quit').onclick = () => { if (mobileArranged && S.role === 'host') $('btn-again').onclick(); else leave(); };
$('btn-start').onclick = () => {
  if (S.role !== 'host') return;
  S.game.startMatch();
  broadcastLobby();
  show('game');
};
$('btn-again').onclick = () => {
  if (S.role !== 'host') return;
  S.game.phase = 'lobby';
  for (const p of S.game.players) p.score = 0;
  broadcastLobby();
  enterLobby();
};
// ---------- Vorschläge fürs Startmenü (Name, Raum, Passwort – alles bleibt änderbar) ----------
// 100 der beliebtesten Vornamen in Deutschland und 100 Beispiel-Raumnamen
const NAMES = [
  'Emilia', 'Emma', 'Sophia', 'Hannah', 'Mia', 'Lina', 'Mila', 'Ella', 'Leni', 'Clara',
  'Lea', 'Marie', 'Frieda', 'Mathilda', 'Lia', 'Emily', 'Ida', 'Lena', 'Anna', 'Luisa',
  'Laura', 'Lotta', 'Johanna', 'Leonie', 'Charlotte', 'Amelie', 'Sophie', 'Malia', 'Lara', 'Nele',
  'Paula', 'Mira', 'Elena', 'Thea', 'Greta', 'Helena', 'Juna', 'Melina', 'Alina', 'Maja',
  'Pia', 'Zoe', 'Nora', 'Romy', 'Liv', 'Carla', 'Marlene', 'Isabella', 'Julia', 'Sarah',
  'Noah', 'Matteo', 'Leon', 'Luca', 'Paul', 'Elias', 'Finn', 'Ben', 'Emil', 'Felix',
  'Henry', 'Theo', 'Jonas', 'Luis', 'Anton', 'Liam', 'Fiete', 'Leo', 'Louis', 'Max',
  'Milan', 'Jakob', 'Oskar', 'Moritz', 'Mats', 'Julian', 'Karl', 'Jonah', 'Elia', 'Alexander',
  'David', 'Lukas', 'Samuel', 'Tim', 'Niklas', 'Jan', 'Tom', 'Mika', 'Levi', 'Malte',
  'Ole', 'Emilio', 'Philipp', 'Hannes', 'Vincent', 'Johann', 'Lio', 'Linus', 'Benjamin', 'Leonard',
];
const ROOMS = [
  'Freitagsrunde', 'Kumpelgruppe', 'Wanderer', 'Arbeitskollegen', 'Stammtisch', 'Spieleabend', 'Zockerbande', 'WG-Runde', 'Familienrunde', 'Nachbarschaft',
  'Sonntagsclub', 'Kegelclub', 'Laufgruppe', 'Feierabendrunde', 'Kaffeeklatsch', 'Studienfreunde', 'Klassentreffen', 'Fussballfreunde', 'Radlergruppe', 'Bergfreunde',
  'Campingfreunde', 'Grillmeister', 'Doppelkopfrunde', 'Skatrunde', 'Mittagspause', 'Teamabend', 'Projektgruppe', 'Lerngruppe', 'Elternabend', 'Gartenfreunde',
  'Nachtschicht', 'Kneipenrunde', 'Bandprobe', 'Chorfreunde', 'Vereinsheim', 'Turnhalle', 'Dorfjugend', 'Abiturjahrgang', 'Ersties', 'Semesterrunde',
  'Kochclub', 'Weinrunde', 'Bierfreunde', 'Brettspielclub', 'Quizrunde', 'Kinoabend', 'Serienjunkies', 'Couchpotatoes', 'Nachteulen', 'Morgenmuffel',
  'Sofahelden', 'Pausenhof', 'Hinterhofbande', 'Strandclique', 'Seglerclub', 'Angelfreunde', 'Kletterclub', 'Skifahrer', 'Almrunde', 'Ferienlager',
  'Urlaubsclique', 'Roadtrip', 'Junggesellen', 'Trauzeugen', 'Cousinen', 'Geschwister', 'Schwiegerfamilie', 'Oma und Opa', 'Patenkinder', 'Krabbelgruppe',
  'Kitaeltern', 'Fahrgemeinschaft', 'Pendlerzug', 'Homeoffice', 'Kaffeeecke', 'Montagsmeeting', 'IT-Abteilung', 'Azubis', 'Werkstatt', 'Lagerhalle',
  'Praxisteam', 'Lehrerzimmer', 'Feuerwehr', 'Rettungswache', 'Tanzgruppe', 'Yogakurs', 'Fitnessstudio', 'Joggingtreff', 'Tennisclub', 'Handballteam',
  'Mopedfreunde', 'Oldtimerclub', 'Gamerclan', 'Lanparty', 'Zeltlager', 'Pfadfinder', 'Nachbarn von oben', 'Hausgemeinschaft', 'Balkonrunde', 'Mitternachtsclub',
];
function rndInt(n) {
  try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; } catch (e) { return Math.floor(Math.random() * n); }
}
const randomName = () => NAMES[rndInt(NAMES.length)];
const randomRoom = () => ROOMS[rndInt(ROOMS.length)];
// Drei Ziffern, ein Punkt, drei Buchstaben, z. B. „482.kfm“
function randomPassword() {
  let d = '', l = '';
  for (let i = 0; i < 3; i++) { d += rndInt(10); l += 'abcdefghijklmnopqrstuvwxyz'[rndInt(26)]; }
  return d + '.' + l;
}

// Zuletzt benutzte Werte wieder eintragen, sonst (beim ersten Besuch) Zufallsvorschläge.
const saved = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
$('in-name').value = saved('ff-name') || randomName();
$('in-room').value = saved('ff-room') || randomRoom();
$('in-pass').value = saved('ff-pass') || randomPassword();
$('btn-random').onclick = () => {
  $('in-name').value = randomName();
  $('in-room').value = randomRoom();
  $('in-pass').value = randomPassword();
};

// Mit Einladungslink geöffnet? Raum und Passwort eintragen, dann den Link aus der Adresszeile nehmen.
(function readInvite() {
  const h = new URLSearchParams(location.hash.slice(1));
  const roomName = (h.get('raum') || '').trim().slice(0, 24), room = slug(roomName);
  if (!room) return;
  // pwx = Passwort als Hex (neu), pw = Klartext (alte Links)
  const pw = hexToPw(h.get('pwx')) || h.get('pw') || '';
  if (pw) h.set('pw', pw);
  $('in-room').value = roomName;
  $('in-pass').value = pw;
  history.replaceState(null, '', location.pathname + location.search);
  startMsg('Du bist in den Raum „' + roomName + '“ eingeladen. Name eingeben und „Raum beitreten“ drücken.' + (h.get('pw') ? '' : ' Das Passwort bekommst du vom Gastgeber.'));
  $('btn-join').classList.remove('secondary'); $('btn-host').classList.add('secondary');
  setTimeout(() => $(h.get('pw') && !$('in-name').value ? 'in-name' : (h.get('pw') ? 'btn-join' : 'in-pass')).focus(), 0);
})();

$('name-form').addEventListener('submit', (e) => { e.preventDefault(); changeMyName($('my-name').value); $('my-name').blur(); });
$('hud').addEventListener('click', (e) => { if (e.target.closest('.hud-p.me')) askName(); });
$('settings').addEventListener('input', () => {
  if (S.role !== 'host' || S.game.phase !== 'lobby') return;
  S.game.settings = readSettings();
  try { localStorage.setItem('ff-settings', JSON.stringify(S.game.settings)); } catch (e) {}
  broadcastLobby();
});
renderRanking();

// ---------- Sound ----------
// Alle Geräusche werden mit der Web Audio API erzeugt, es gibt keine Sounddateien.
const Sound = (() => {
  let ac = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('ff-mute') === '1'; } catch (e) {}
  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ac = new AC(); master = ac.createGain(); master.gain.value = muted ? 0 : 0.5; master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function tone(type, f1, f2, dur, vol, delay = 0) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f1, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    env(g, t, 0.01, vol, dur); o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, vol, f1, f2, delay = 0) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay, src = ac.createBufferSource(), flt = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf; flt.type = 'lowpass'; flt.frequency.setValueAtTime(f1, t); flt.frequency.exponentialRampToValueAtTime(f2, t + dur);
    env(g, t, 0.005, vol, dur); src.connect(flt); flt.connect(g); g.connect(master); src.start(t); src.stop(t + dur + 0.05);
  }
  const fx = {
    place: () => { tone('square', 220, 110, 0.08, 0.25); },
    boom: () => { noise(0.7, 0.9, 2400, 80); tone('sine', 90, 30, 0.5, 0.7); },
    pickup: () => { [660, 880, 1320].forEach((f, i) => tone('triangle', f, 0, 0.09, 0.3, i * 0.06)); },
    death: () => { tone('sawtooth', 500, 60, 0.6, 0.3); },
    start: () => { [523, 659, 784].forEach((f, i) => tone('square', f, 0, 0.12, 0.18, i * 0.12)); },
    round: () => { [784, 659, 784, 1047].forEach((f, i) => tone('triangle', f, 0, 0.15, 0.3, i * 0.13)); },
    chat: () => { tone('sine', 1175, 0, 0.12, 0.08, 0); tone('sine', 1568, 0, 0.12, 0.08, 0.07); },
    draw: () => { [392, 330].forEach((f, i) => tone('triangle', f, 0, 0.25, 0.3, i * 0.2)); },
    win: () => { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone('square', f, 0, i === 5 ? 0.5 : 0.14, 0.2, i * 0.14)); },
    mega: () => { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone('triangle', f, 0, 0.12, 0.3, i * 0.05)); tone('sine', 1568, 2093, 0.4, 0.15, 0.3); },
    shieldhit: () => { tone('square', 880, 220, 0.25, 0.25); noise(0.2, 0.3, 4000, 500); },
    thud: () => { tone('sine', 140, 50, 0.15, 0.35); },
    tick: () => { tone('square', 1200, 0, 0.04, 0.12); },
  };
  return {
    init, play: (name) => fx[name] && fx[name](),
    get muted() { return muted; },
    toggle() {
      muted = !muted; try { localStorage.setItem('ff-mute', muted ? '1' : '0'); } catch (e) {}
      init(); if (master) master.gain.value = muted ? 0 : 0.5;
      return muted;
    },
  };
})();
// Browser erlauben Ton erst nach einer Nutzeraktion
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => Sound.init(), { capture: true });
function updateMuteBtn() {
  $('btn-mute').innerHTML = Sound.muted ? '🔇<span class="lbl"> Ton aus</span>' : '🔊<span class="lbl"> Ton an</span>';
  $('btn-mute').setAttribute('aria-label', Sound.muted ? 'Ton ist aus, einschalten' : 'Ton ist an, ausschalten');
}
$('btn-mute').onclick = () => { Sound.toggle(); updateMuteBtn(); $('btn-mute').blur(); };
updateMuteBtn();

// Geräusche aus Änderungen des Spielstands ableiten (funktioniert beim Gastgeber und bei Mitspielern gleich)
let prevView = null;
function soundsFor(v) {
  const p = prevView; prevView = v;
  if (!p || p === v) return;
  if (v.phase === 'play' && (p.phase !== 'play' || v.round !== p.round)) Sound.play('start');
  if (v.phase !== p.phase) {
    if (v.phase === 'matchEnd') Sound.play('win');
    else if (v.phase === 'roundEnd') Sound.play(/gewinnt/.test(v.msg) ? 'round' : 'draw');
  }
  if (v.phase !== 'play' && p.phase !== 'play') return;
  const key = (b) => b[0] + ',' + b[1];
  const oldF = new Set(p.flames.map(key));
  if (v.flames.some((f) => !oldF.has(key(f)))) Sound.play('boom');
  else if (v.grid !== p.grid && v.variant === 'schrumpf' && v.clock >= SHRINK_AT && (v.grid.split('1').length > p.grid.split('1').length)) Sound.play('thud');
  else if (v.bombs.length > p.bombs.length) Sound.play('place');
  const before = new Map(p.players.map((q) => [q.id, q]));
  for (const q of v.players) {
    const o = before.get(q.id); if (!o) continue;
    if (o.alive && !q.alive) Sound.play('death');
    else if (q.alive && ((q.pierce && !o.pierce) || (q.shield && !o.shield) || q.ghost > o.ghost || (q.remote && !o.remote) || q.range - o.range > 1)) Sound.play('mega');
    else if (q.alive && (q.bombs > o.bombs || q.range > o.range || q.speed > o.speed || (q.kick && !o.kick))) Sound.play('pickup');
    else if (q.alive && o.shield && !q.shield) Sound.play('shieldhit');
  }
}

// ---------- Zeichnen ----------
const cv = $('cv'), ctx = cv.getContext('2d');
let lastHud = '';
function draw(v, isHost) {
  if (v.w && v.h) applySize(v.w, v.h);
  soundsFor(v);
  const now = performance.now() / 1000;
  const grid = v.grid;
  // Boden
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = +grid[y * W + x];
    const px = x * T, py = y * T;
    if (t === WALL) drawWall(px, py);
    else {
      ctx.fillStyle = (x + y) % 2 ? '#2f5a3a' : '#33613f';
      ctx.fillRect(px, py, T, T);
      if (t === CRATE) drawCrate(px, py);
    }
  }
  for (const [x, y, type] of v.items) drawItem(x * T, y * T, type, now);
  for (const [x, y, fuse, remote] of v.bombs) drawBomb(x * T, y * T, remote ? FUSE : fuse, now, remote);
  drawFlames(v.flames, now);

  // Spieler (beim Client geglättet)
  const players = [...v.players].sort((a, b) => a.y - b.y);
  for (const p of players) {
    let d = S.disp.get(p.id);
    if (!d || isHost || Math.hypot(d.x - p.x, d.y - p.y) > 2) d = { x: p.x, y: p.y };
    else { d.x += (p.x - d.x) * 0.35; d.y += (p.y - d.y) * 0.35; }
    S.disp.set(p.id, d);
    if (p.alive) drawPlayer(d.x * T, d.y * T, p, now);
  }

  // Anzeige oben
  const hud = v.players.map((p) =>
    `<span class="hud-p${p.alive || v.phase === 'lobby' ? '' : ' dead'}${p.id === S.myId ? ' me' : ''}"${p.id === S.myId ? ' title="Antippen, um deinen Namen zu ändern"' : ''}><span class="dot" style="background:${p.color}"></span>${esc(p.name)} <b title="Siege in dieser Sitzung">🏆 ${p.score}</b>` +
    (p.waiting ? ' <small>👀 ab nächster Runde</small>' : '') +
    (p.id === S.myId ? ` <small>💣${p.bombs} 🔥${p.range} 👟${p.speed}${p.kick ? ' 🦶' : ''}${p.pierce ? ' 💥' : ''}${p.shield ? ' 🛡️' : ''}${p.ghost ? ' 👻' + p.ghost : ''}${p.remote ? ' 🧨 Strg' : ''}</small>` : '') + '</span>').join('');
  if (hud !== lastHud) { $('hud').innerHTML = hud; lastHud = hud; }
  const ov = $('overlay');
  ov.classList.toggle('hidden', !v.msg);
  if (v.msg && ov.textContent !== v.msg) ov.textContent = v.msg;
  $('btn-again').classList.toggle('hidden', !isHost);
}

function drawWall(px, py) {
  ctx.fillStyle = '#4b4f63'; ctx.fillRect(px, py, T, T);
  ctx.fillStyle = '#5f6479'; ctx.fillRect(px + 3, py + 3, T - 6, T - 6);
  ctx.fillStyle = '#6e7389'; ctx.fillRect(px + 3, py + 3, T - 6, 6);
  ctx.fillStyle = '#3c3f50'; ctx.fillRect(px + 3, py + T - 9, T - 6, 6);
}
function drawCrate(px, py) {
  ctx.fillStyle = '#8a5a2b'; ctx.fillRect(px + 4, py + 4, T - 8, T - 8);
  ctx.fillStyle = '#a8713a'; ctx.fillRect(px + 7, py + 7, T - 14, T - 14);
  ctx.strokeStyle = '#6b431e'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(px + 8, py + 8); ctx.lineTo(px + T - 8, py + T - 8); ctx.moveTo(px + T - 8, py + 8); ctx.lineTo(px + 8, py + T - 8); ctx.stroke();
  ctx.strokeStyle = '#5a3818'; ctx.lineWidth = 2; ctx.strokeRect(px + 5, py + 5, T - 10, T - 10);
}
function drawItem(px, py, type, now) {
  const bob = Math.sin(now * 4 + px) * 2;
  if (MEGA.has(type)) {
    // Mega-Items: leuchtender, pulsierender Regenbogenrand
    const glow = 0.5 + Math.sin(now * 6) * 0.5;
    ctx.save(); ctx.shadowColor = `hsl(${(now * 120) % 360}, 100%, 60%)`; ctx.shadowBlur = 10 + glow * 12;
    ctx.fillStyle = '#3a2a5c'; roundRect(px + 4, py + 4 + bob, T - 8, T - 8, 10); ctx.fill(); ctx.restore();
    ctx.strokeStyle = `hsl(${(now * 120) % 360}, 100%, 65%)`; ctx.lineWidth = 3; roundRect(px + 4, py + 4 + bob, T - 8, T - 8, 10); ctx.stroke();
  } else {
    ctx.fillStyle = '#1d2033'; roundRect(px + 6, py + 6 + bob, T - 12, T - 12, 8); ctx.fill();
    ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.font = '24px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ITEM_ICON[type], px + T / 2, py + T / 2 + 1 + bob);
}
function drawBomb(px, py, fuse, now, remote) {
  const pulse = 1 + Math.sin(now * (6 + (FUSE - fuse) * 8)) * 0.06;
  const cx = px + T / 2, cy = py + T / 2 + 3, r = 15 * pulse;
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(cx, py + T - 7, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = fuse < 0.6 && Math.floor(now * 12) % 2 ? '#7a1f1f' : '#1b1c26';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.arc(cx - 5, cy - 5, 4, 0, Math.PI * 2); ctx.fill();
  if (remote) {
    // Fernzünder-Bombe: Antenne mit blinkendem roten Licht statt Zündschnur
    ctx.strokeStyle = '#9aa0b4'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx + 4, cy - 13); ctx.lineTo(cx + 9, cy - 24); ctx.stroke();
    ctx.fillStyle = Math.floor(now * 3) % 2 ? '#ff3b3b' : '#7a1f1f';
    ctx.beginPath(); ctx.arc(cx + 9, cy - 25, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,59,59,.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, Math.PI * 2); ctx.stroke();
    return;
  }
  ctx.strokeStyle = '#c9b48a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx + 6, cy - 12); ctx.quadraticCurveTo(cx + 12, cy - 20, cx + 8, cy - 23); ctx.stroke();
  ctx.fillStyle = Math.floor(now * 16) % 2 ? '#ffe066' : '#ff7b2e';
  ctx.beginPath(); ctx.arc(cx + 8, cy - 23, 3.5, 0, Math.PI * 2); ctx.fill();
}
function drawFlames(flames, now) {
  if (!flames.length) return;
  const set = new Set(flames.map(([x, y]) => x + ',' + y));
  const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const flick = 0.9 + Math.sin(now * 30) * 0.1;
  ctx.save();
  ctx.lineCap = 'round';
  // Drei Schichten von außen (orange) nach innen (hell); jede Schicht über alle Felder,
  // damit sich benachbarte Flammen nahtlos verbinden. Enden laufen rund aus.
  for (const [col, sc] of [['#ff5a1f', 0.92], ['#ffb02e', 0.64], ['#fff3b0', 0.34]]) {
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = T * sc * flick;
    for (const [x, y] of flames) {
      const cx = x * T + T / 2, cy = y * T + T / 2;
      const nb = DIRS4.filter(([dx, dy]) => set.has((x + dx) + ',' + (y + dy)));
      const wob = Math.sin(now * 25 + x * 7 + y * 3) * 0.04;
      if (!nb.length) {
        // Einzelnes Feld (Bombe ohne Platz): runder Feuerball
        ctx.beginPath(); ctx.arc(cx, cy, T * (0.52 + wob) * (sc / 0.92) * flick, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      ctx.beginPath();
      for (const [dx, dy] of nb) { ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * T / 2, cy + dy * T / 2); }
      if (nb.length === 1) {
        // Ende eines Strahls: Spitze läuft ins Feld hinein aus und wird rund abgeschlossen
        const [dx, dy] = nb[0];
        const tip = T * (0.22 + wob);
        ctx.moveTo(cx, cy); ctx.lineTo(cx - dx * tip, cy - dy * tip);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}
function drawPlayer(px, py, p, now) {
  if (p.grace && Math.floor(now * 12) % 2) return; // blinkt nach Schild-Treffer
  ctx.save();
  if (p.ghost) ctx.globalAlpha = p.ghost <= 2 && Math.floor(now * 8) % 2 ? 0.75 : 0.45;
  drawPlayerBody(px, py, p, now);
  ctx.restore();
  if (p.shield) {
    const cx = px + T / 2, cy = py + T / 2 + 2, r = 23 + Math.sin(now * 5) * 1.5;
    ctx.strokeStyle = 'rgba(140, 220, 255, .85)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(140, 220, 255, .12)'; ctx.fill();
  }
  if (p.pierce) {
    ctx.fillStyle = '#ff5a1f'; ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💥', px + T - 6, py + 10);
  }
}
function drawPlayerBody(px, py, p, now) {
  const cx = px + T / 2, base = py + T - 6;
  const bounce = p.moving ? Math.abs(Math.sin(now * 14)) * 3 : 0;
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(cx, base, 14, 5, 0, 0, Math.PI * 2); ctx.fill();
  // Füße
  ctx.fillStyle = '#1b1c26';
  const step = p.moving ? Math.sin(now * 14) * 4 : 0;
  ctx.beginPath(); ctx.ellipse(cx - 7 + step, base - 2, 6, 4, 0, 0, Math.PI * 2); ctx.ellipse(cx + 7 - step, base - 2, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
  // Körper (Tropfenform)
  const by = base - 18 - bounce;
  ctx.fillStyle = p.color;
  ctx.beginPath(); ctx.ellipse(cx, by, 16, 17, 0, 0, Math.PI * 2); ctx.fill();
  // Antenne
  ctx.strokeStyle = p.color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx, by - 16); ctx.lineTo(cx + 3, by - 25); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx + 3, by - 26, 3, 0, Math.PI * 2); ctx.fill();
  // Visier und Augen je nach Blickrichtung
  const ox = p.dir === 'left' ? -5 : p.dir === 'right' ? 5 : 0;
  const oy = p.dir === 'up' ? -4 : p.dir === 'down' ? 2 : 0;
  if (p.dir !== 'up') {
    ctx.fillStyle = '#1b1c26'; roundRect(cx - 11 + ox, by - 7 + oy, 22, 11, 5); ctx.fill();
    ctx.fillStyle = '#9ff7ff';
    ctx.fillRect(cx - 7 + ox, by - 4 + oy, 4, 5); ctx.fillRect(cx + 3 + ox, by - 4 + oy, 4, 5);
  }
  // Name
  ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(p.name, cx + 1, py - 1 - bounce + 1);
  ctx.fillStyle = '#fff'; ctx.fillText(p.name, cx, py - 1 - bounce);
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Für Tests von außen erreichbar
window.Funkenfeld = { Game, S, Sound };
// ---------- Neue Version erkennen ----------
// GitHub Pages lässt Browser Dateien bis zu 10 Minuten zwischenspeichern. Darum fragt das Spiel
// version.txt ohne Cache ab und bietet bei einer neuen Version einen Knopf zum Neuladen an.
(function updateCheck() {
  if (VERSION.startsWith('__')) return; // lokal ohne Veröffentlichung
  let newer = null;
  async function check() {
    try {
      const r = await fetch('version.txt?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = (await r.text()).trim();
      if (v && v !== VERSION) { newer = v; $('update-bar').classList.remove('hidden'); }
    } catch (e) {}
  }
  $('btn-update').addEventListener('click', () => {
    const q = new URLSearchParams(location.search); q.set('v', newer || Date.now());
    location.replace(location.pathname + '?' + q.toString() + location.hash);
  });
  check();
  setInterval(() => { if (!inGame()) check(); }, 120000);
})();


// Versteckte Hilfe: Wer 10-mal schnell auf dieselbe Stelle tippt (oder klickt), bekommt erklärt, was sie tut.
const HELP = [
  ['#touch-bomb', 'Bombe legen. Sie explodiert nach kurzer Zeit in alle vier Richtungen und sprengt Kisten. Am PC: Leertaste oder Enter.'],
  ['#touch-det', 'Fernzünder: Mit dem 🧨-Item gehen deine Bomben erst hoch, wenn du hier tippst (spätestens nach 20 Sekunden). Am PC: Strg.'],
  ['.pad button', 'Steuerkreuz: Gedrückt halten, um in diese Richtung zu laufen. Am PC: Pfeiltasten oder WASD.'],
  ['#stage', 'Das Spielfeld. Bei „Wischen“: irgendwo in eine Richtung wischen und den Finger liegen lassen, um zu laufen. Bomben legst du mit dem 💣-Knopf.'],
  ['.ctl-pick label', 'Handysteuerung: „Tasten“ zeigt ein Steuerkreuz, bei „Wischen“ wischst du irgendwo auf dem Bildschirm. Gilt nur für diesen Browser.'],
  ['#btn-mute', 'Schaltet Ton und Effekte an oder aus.'],
  ['#btn-quit', 'Auf dem Handy (✕): Der Gastgeber holt alle zurück in die Lobby, Mitspieler verlassen den Raum. Am PC: Raum verlassen.'],
  ['#btn-leave', 'Verlässt den Raum. Bist du der Gastgeber, endet das Spiel für alle.'],
  ['#btn-again', 'Nur für den Gastgeber: zurück in die Lobby, die Siege dieser Sitzung starten wieder bei 0.'],
  ['#btn-start', 'Startet das Spiel für alle im Raum. Das kann nur der Gastgeber.'],
  ['#btn-host', 'Erstellt einen neuen Raum mit Name und Passwort. Dein Browser ist dann der Gastgeber, auf dem das Spiel läuft.'],
  ['#btn-join', 'Tritt einem bestehenden Raum bei. Raumname und Passwort bekommst du vom Gastgeber.'],
  ['#btn-copy', 'Kopiert den Einladungslink. Wer ihn öffnet, muss nur noch einen Namen eingeben.'],
  ['#btn-share', 'Teilt den Einladungslink über die Teilen-Funktion deines Handys.'],
  ['.mode-pick label', '„Klassisch“ nutzt feste Regeln. Bei „Individuell“ stellt der Gastgeber Items, Feld und Modus selbst ein.'],
  ['#btn-update', 'Lädt die neueste Version von BombRe.'],
  ['#chat-toggle', 'Öffnet den Chat. Die Zahl zeigt neue Nachrichten.'],
  ['#chat-close', 'Schließt den Chat. Auf dem Handy kannst du ihn auch nach unten wegziehen.'],
  ['.chat-pop', 'Schaltet die kurzen Einblendungen neuer Chatnachrichten an oder aus.'],
  ['#chat-form button', 'Schickt deine Nachricht an alle im Raum.'],
  ['#chat-log', 'Der Chatverlauf dieser Sitzung. Er wird nirgends gespeichert.'],
  ['.ranking', 'Die Rangliste: Siege aus den Spielen in diesem Browser.'],
  ['#hud', 'Alle Spieler mit ihren Siegen. Bei dir stehen zusätzlich deine Bomben 💣, Reichweite 🔥 und Tempo 👟.'],
];
(() => {
  let target = null, count = 0, last = 0, bubble = null, hideT = 0;
  const hide = () => { if (bubble) { bubble.remove(); bubble = null; } clearTimeout(hideT); };
  const show = (el, text) => {
    hide();
    bubble = document.createElement('div'); bubble.className = 'help-bubble'; bubble.setAttribute('role', 'status');
    bubble.textContent = text; document.body.appendChild(bubble);
    const r = el.getBoundingClientRect(), b = bubble.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - b.width / 2), innerWidth - b.width - 8);
    const top = r.top - b.height - 10 >= 8 ? r.top - b.height - 10 : Math.min(r.bottom + 10, innerHeight - b.height - 8);
    bubble.style.left = left + 'px'; bubble.style.top = Math.max(8, top) + 'px';
    hideT = setTimeout(hide, 7000);
  };
  window.addEventListener('pointerdown', (e) => {
    if (bubble && !bubble.contains(e.target)) hide();
    let el = null, text = '';
    for (const [sel, t] of HELP) { const m = e.target.closest && e.target.closest(sel); if (m) { el = m; text = t; break; } }
    const now = performance.now();
    if (!el || el !== target || now - last > 450) { target = el; count = 0; }
    last = now;
    if (!el) return;
    if (++count >= 10) { count = 0; show(el, text); }
  }, { capture: true, passive: true });
})();

// Chat-Bedienung
$('chat-form').addEventListener('submit', (e) => { e.preventDefault(); const i = $('chat-in'); Chat.send(i.value); i.value = ''; });
$('chat-toggle').addEventListener('click', () => { Chat.setOpen(!Chat.open); if (Chat.open && !Chat.mobile()) $('chat-in').focus(); });
$('chat-close').addEventListener('click', () => Chat.setOpen(false));
// Handy: Chat am Griff oder Kopf nach unten ziehen, um ihn zu schließen
(() => {
  const box = $('chat'); let y0 = null, dy = 0;
  const start = (e) => {
    if (!Chat.mobile() || !Chat.open || e.target.closest('input, button, label')) return;
    y0 = e.clientY; dy = 0; box.style.transition = 'none';
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  };
  const move = (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); box.style.transform = `translateY(${dy}px)`; };
  const end = () => {
    if (y0 === null) return;
    y0 = null; box.style.transition = 'transform .18s';
    if (dy > Math.min(90, box.offsetHeight / 3)) {
      box.style.transform = `translateY(${box.offsetHeight + 20}px)`;
      setTimeout(() => { Chat.setOpen(false); box.style.transform = ''; box.style.transition = ''; }, 180);
    } else box.style.transform = '';
  };
  for (const el of [box.querySelector('.chat-grip'), box.querySelector('.chat-head')]) {
    el.addEventListener('pointerdown', start); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
})();
$('chat-popup').checked = Chat.popups;
$('chat-popup').addEventListener('change', (e) => {
  Chat.popups = e.target.checked;
  try { localStorage.setItem('ff-chat-popup', Chat.popups ? 'an' : 'aus'); } catch (err) {}
});
Chat.render();
})();
