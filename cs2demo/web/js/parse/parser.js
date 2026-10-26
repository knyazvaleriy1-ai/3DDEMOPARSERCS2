// Port of cs2demo/parser.py (keep the two in sync): turns demoparser2 output
// (from the WebAssembly build, see wasm/) into the same meta + frames the
// Python parser writes, so the viewer works the same without a server.
//
// `wasm` must already hold the demo bytes (begin/push). Tick data comes back
// column-wise: Float32Array/Float64Array (NaN = missing), Uint8Array booleans
// (2 = missing) and dictionary-encoded strings {dict, idx}.

import { detectHighlights } from './highlights.js';
import { cmpStr, floorDiv, pyMod, pyRound, roundHalfEven } from './pyutil.js';

export const FORMAT_VERSION = 1;
export const GENERATOR = 'cs2demo-web 0.1';

const FLAG_PRESENT = 1, FLAG_ALIVE = 2, FLAG_CT = 4, FLAG_SCOPED = 8, FLAG_DEFUSING = 16,
  FLAG_HELMET = 32, FLAG_DEFUSER = 64, FLAG_AIRBORNE = 128;

// On-screen keyboard: bit i of the "keys" section is KEY_NAMES[i], i.e. bit
// KEY_BUTTONS[i][1] of the game's button mask (m_nButtonDownMaskPrev).
export const KEY_BUTTONS = [['W', 3], ['A', 9], ['S', 4], ['D', 10], ['SPACE', 1], ['CTRL', 2], ['SHIFT', 16],
  ['LMB', 0], ['RMB', 11], ['R', 13], ['E', 5], ['TAB', 33], ['F', 35]];
const KEY_SPACE = 4;
// A jump with the jump button never held was bound to the mouse wheel (a
// scroll presses and releases +jump within one tick).
const KEY_WHEEL = 13;
export const KEY_NAMES = [...KEY_BUTTONS.map(([k]) => k), 'WHEEL'];
// demoparser2's single-button props -> bit of the mask (its raw "buttons"
// column is missing in some demos). meta.frames.keysKnown lists the keys
// there is data for.
const BUTTON_PROPS = { FORWARD: 3, LEFT: 9, BACK: 4, RIGHT: 10, JUMP: 1, DUCK: 2, WALK: 16, FIRE: 0, RIGHTCLICK: 11,
  RELOAD: 13, USE: 5, SCOREBOARD: 33, INSPECT: 35 };

const U8_FIELDS = ['health', 'armor', 'flags', 'weapon', 'duck', 'place'];

export const TICK_PROPS = ['X', 'Y', 'Z', 'yaw', 'pitch', 'health', 'armor_value', 'team_num', 'is_alive',
  'active_weapon_name', 'balance', 'has_helmet', 'has_defuser', 'is_scoped', 'is_defusing', 'duck_amount',
  'last_place_name', 'game_time', 'is_airborne'];

const SCOREBOARD_PROPS = ['kills_total', 'deaths_total', 'assists_total', 'damage_total', 'team_rounds_total',
  'mvps', 'score', 'team_clan_name'];

export const EVENTS = ['begin_new_match', 'round_start', 'round_freeze_end', 'round_end', 'round_officially_ended',
  'player_death', 'player_hurt', 'player_blind', 'weapon_fire', 'bomb_pickup', 'bomb_dropped', 'bomb_beginplant',
  'bomb_planted', 'bomb_begindefuse', 'bomb_defused', 'bomb_exploded', 'smokegrenade_detonate',
  'smokegrenade_expired', 'inferno_startburn', 'inferno_expire', 'flashbang_detonate', 'hegrenade_detonate',
  'decoy_started', 'decoy_detonate'];

const GRENADE_TYPES = {
  CSmokeGrenadeProjectile: 'smoke', CFlashbangProjectile: 'flash', CHEGrenadeProjectile: 'he',
  CMolotovProjectile: 'molotov', CIncendiaryGrenadeProjectile: 'molotov', CDecoyProjectile: 'decoy',
};

const SMOKE_SECONDS = 20.0, INFERNO_SECONDS = 7.0, DECOY_SECONDS = 15.0;
const MISSING = 0xffffffff;

export class DemoParseError extends Error {}

// -- value helpers (Python's _is_missing/_sid/_str/_bool/_num) ------------------------

const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

function sid(v) {
  if (isMissing(v)) return null;
  if (typeof v === 'string') {
    v = v.trim();
    if (v.endsWith('.0')) v = v.slice(0, -2);
    return v || null;
  }
  return String(Math.trunc(v));
}

const str = (v) => (isMissing(v) ? '' : String(v));

function bool(v) {
  if (isMissing(v)) return false;
  if (typeof v === 'string') return ['true', '1'].includes(v.toLowerCase());
  return Boolean(v);
}

function num(v, dflt = 0) {
  if (isMissing(v)) return dflt;
  const x = typeof v === 'boolean' ? Number(v) : Number(v);
  return Number.isNaN(x) ? dflt : x;
}

const int = (v) => Math.trunc(num(v));

function playerKey(steamid, name) {
  const s = sid(steamid);
  if (!s || s === '0') return `bot:${str(name)}`;
  return s;
}

class Players {
  constructor(keys, names) {
    this.index = new Map(keys.map((k, i) => [k, i]));
    this.byName = new Map();
    names.forEach((n, i) => { if (!this.byName.has(n)) this.byName.set(n, i); });
  }

  get(steamid, name) {
    const key = playerKey(steamid, name);
    if (this.index.has(key)) return this.index.get(key);
    if (name !== null && name !== undefined && this.byName.has(str(name))) return this.byName.get(str(name));
    return -1;
  }
}

// -- columns --------------------------------------------------------------------------

const colStr = (c, i) => {
  if (!c) return null;
  const k = c.idx[i];
  return k === MISSING ? null : c.dict[k];
};
const colBool = (c, i) => (c ? c[i] === 1 : false);
const colNum = (c, i) => (c ? c[i] : NaN);

const sortedSet = (xs) => [...new Set(xs)].sort((a, b) => a - b);
const rows = (events, name) => events[name] || [];

function detectTickRate(cols, n) {
  // first row per tick, in tick order (rows already are)
  let firstTick = null, firstTime = NaN, lastTick = null, lastTime = NaN;
  const tick = cols.tick, time = cols.game_time;
  if (!tick || !time || n < 2) return 64.0;
  let prev = null;
  for (let i = 0; i < n; i++) {
    if (tick[i] === prev) continue;
    prev = tick[i];
    if (firstTick === null) { firstTick = tick[i]; firstTime = time[i]; }
    lastTick = tick[i]; lastTime = time[i];
  }
  if (firstTick === lastTick) return 64.0;
  const dt = lastTime - firstTime, dtick = lastTick - firstTick;
  if (!(dt > 0)) return 64.0;
  const rate = dtick / dt;
  for (const c of [64.0, 128.0, 32.0]) if (Math.abs(rate - c) / c < 0.05) return c;
  return pyRound(rate, 3);
}

/**
 * Parse the demo loaded into `wasm`. Returns {meta, frames} where frames is
 * an ArrayBuffer laid out like frames.bin.
 */
export function parseLoaded(wasm, { fileName = 'demo.dem', step = 2, progress = () => {}, now = () => Date.now() } = {}) {
  const started = now();
  progress(0.02, 'Чтение заголовка');
  let header;
  try {
    header = wasm.header();
  } catch (err) {
    throw new DemoParseError(`Не удалось открыть демо: ${err.message || err}`);
  }

  progress(0.06, 'Игровые события');
  const events = wasm.events(EVENTS, [], []);
  let lastEventTick = 0;
  for (const list of Object.values(events)) for (const r of list) lastEventTick = Math.max(lastEventTick, r.tick);

  step = Math.max(1, Math.trunc(step || 2));
  progress(0.2, 'Позиции игроков');
  const wantedTicks = [];
  for (let t = 0; t < lastEventTick + 64 * 300; t += step) wantedTicks.push(t);
  const tk = wasm.ticks([...TICK_PROPS, ...Object.keys(BUTTON_PROPS)], Int32Array.from(wantedTicks));
  const n = tk.rows;
  const c = tk.columns;
  if (!n) throw new DemoParseError('В демо нет данных об игроках');
  const tickRate = detectTickRate(c, n);

  progress(0.55, 'Сборка кадров');
  // Rows of real players (team T/CT) with their key.
  const team = c.team_num, tick = c.tick;
  const keyOf = new Array(n);
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (team[i] === 2 || team[i] === 3) {
      keep[i] = 1;
      keyOf[i] = playerKey(colStr(c.steamid, i), colStr(c.name, i));
    }
  }
  // Coaches and casters can be "alive" during warmup only: count life after match start.
  const matchStarts = rows(events, 'begin_new_match').map((r) => r.tick);
  let aliveAfter = null;
  if (matchStarts.length) {
    const ms = Math.max(...matchStarts);
    for (let i = 0; i < n; i++) {
      if (keep[i] && colBool(c.is_alive, i) && tick[i] > ms) { aliveAfter = ms; break; }
    }
  }
  const isAlive = (i) => colBool(c.is_alive, i) && (aliveAfter === null || tick[i] > aliveAfter);
  // ...and some coach slots sit "alive" in one spot (teleported between halves)
  // for the whole match: require real walking, not just one jump.
  const walking = new Map();
  const lastXY = new Map();
  for (let i = 0; i < n; i++) {
    if (!keep[i] || !isAlive(i)) continue;
    const k = keyOf[i];
    const x = c.X[i], y = c.Y[i];
    const prev = lastXY.get(k);
    if (!walking.has(k)) walking.set(k, 0);
    if (prev) {
      const d = Math.hypot(x - prev[0], y - prev[1]);
      if (d > 0.5 && d < 200) walking.set(k, walking.get(k) + 1);
    }
    lastXY.set(k, [x, y]);
  }
  const aliveKeys = new Set([...walking].filter(([, v]) => v >= 20).map(([k]) => k));
  let t0 = Infinity, t1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (keep[i] && !aliveKeys.has(keyOf[i])) keep[i] = 0;
    if (keep[i]) { t0 = Math.min(t0, tick[i]); t1 = Math.max(t1, tick[i]); }
  }
  if (t0 === Infinity) throw new DemoParseError('В демо не найдено живых игроков');
  t0 -= pyMod(t0, step);
  const frameCount = floorDiv(t1 - t0, step) + 1;

  // Player list: ordered by starting side, then name.
  const info = new Map();
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const k = keyOf[i];
    let p = info.get(k);
    if (!p) info.set(k, (p = { key: k, firstAlive: -1, first: i, last: i }));
    if (p.firstAlive < 0 && colBool(c.is_alive, i)) p.firstAlive = i;
    p.last = i;
  }
  const playersInfo = [...info.values()].map((p) => {
    const first = p.firstAlive >= 0 ? p.firstAlive : p.first;
    return {
      key: p.key,
      steamid: p.key.startsWith('bot:') ? '' : p.key,
      name: String(colStr(c.name, p.last)),
      bot: p.key.startsWith('bot:'),
      startSide: team[first] === 3 ? 'CT' : 'T',
    };
  });
  const order = playersInfo.map((p, i) => i).sort((a, b) => {
    const pa = playersInfo[a], pb = playersInfo[b];
    const sa = pa.startSide !== 'T' ? 1 : 0, sb = pb.startSide !== 'T' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return cmpStr(pa.name.toLowerCase(), pb.name.toLowerCase());
  });
  const players = order.map((i) => playersInfo[i]);
  const pindex = new Map(players.map((p, i) => [p.key, i]));
  const P = players.length;
  const lookup = new Players(players.map((p) => p.key), players.map((p) => p.name));

  const uniq = (col) => {
    const s = new Set();
    for (let i = 0; i < n; i++) if (keep[i]) { const v = colStr(col, i); if (v) s.add(v); }
    return ['', ...[...s].sort(cmpStr).slice(0, 255)];
  };
  const weapons = uniq(c.active_weapon_name);
  const weaponIdx = new Map(weapons.map((w, i) => [w, i]));
  const places = uniq(c.last_place_name);
  const placeIdx = new Map(places.map((p, i) => [p, i]));

  const pos = new Float32Array(frameCount * P * 3);
  const ang = new Int16Array(frameCount * P * 2);
  const u8 = new Uint8Array(frameCount * P * U8_FIELDS.length);
  const money = new Uint16Array(frameCount * P);
  const keys = new Uint16Array(frameCount * P);
  const { keysAt, known: keysKnown } = buttonKeys(c);
  const clip = (v, lo, hi) => (Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)));
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const f = floorDiv(tick[i] - t0, step);
    const p = pindex.get(keyOf[i]);
    const fp = f * P + p;
    const nz = (v) => (Number.isNaN(v) ? 0 : v);
    pos[fp * 3] = nz(c.X[i]);
    pos[fp * 3 + 1] = nz(c.Y[i]);
    pos[fp * 3 + 2] = nz(c.Z[i]);
    const yaw = pyMod(nz(c.yaw[i]) + 180.0, 360.0) - 180.0;
    const pitch = clip(nz(c.pitch[i]), -90, 90);
    ang[fp * 2] = roundHalfEven(yaw * 100);
    ang[fp * 2 + 1] = roundHalfEven(pitch * 100);
    let flags = FLAG_PRESENT;
    if (colBool(c.is_alive, i)) flags |= FLAG_ALIVE;
    if (team[i] === 3) flags |= FLAG_CT;
    if (colBool(c.is_scoped, i)) flags |= FLAG_SCOPED;
    if (colBool(c.is_defusing, i)) flags |= FLAG_DEFUSING;
    if (colBool(c.has_helmet, i)) flags |= FLAG_HELMET;
    if (colBool(c.has_defuser, i)) flags |= FLAG_DEFUSER;
    if (colBool(c.is_airborne, i)) flags |= FLAG_AIRBORNE;
    const b = fp * 6;
    u8[b] = Math.trunc(clip(colNum(c.health, i), 0, 255));
    u8[b + 1] = Math.trunc(clip(colNum(c.armor_value, i), 0, 255));
    u8[b + 2] = flags;
    u8[b + 3] = weaponIdx.get(colStr(c.active_weapon_name, i)) ?? 0;
    // float32 multiply, like numpy on the float32 column
    u8[b + 4] = Math.trunc(clip(Math.fround(nz(colNum(c.duck_amount, i)) * 255), 0, 255));
    u8[b + 5] = placeIdx.get(colStr(c.last_place_name, i)) ?? 0;
    money[fp] = Math.trunc(clip(colNum(c.balance, i), 0, 65535));
    keys[fp] = keysAt(i);
  }
  if (keysKnown.includes('SPACE') && c.is_airborne) {
    const fl = new Uint8Array(frameCount * P), z = new Float32Array(frameCount * P);
    for (let i = 0; i < frameCount * P; i++) { fl[i] = u8[i * 6 + 2]; z[i] = pos[i * 3 + 2]; }
    markWheelJumps(keys, fl, z, frameCount, P, step);
    keysKnown.push('WHEEL');
  }

  const frameOf = (t) => Math.min(Math.max(floorDiv(t - t0, step), 0), frameCount - 1);
  const flagsAt = (t, p) => u8[(frameOf(t) * P + p) * 6 + 2];
  const posAt = (t, p) => {
    const o = (frameOf(t) * P + p) * 3;
    return [pyRound(pos[o], 1), pyRound(pos[o + 1], 1), pyRound(pos[o + 2], 1)];
  };
  const side = (t, p) => {
    if (p < 0) return null;
    const fl = flagsAt(t, p);
    if (!(fl & FLAG_PRESENT)) return null;
    return fl & FLAG_CT ? 'CT' : 'T';
  };

  progress(0.6, 'Раунды и события');
  const rounds = buildRounds(events, t0, t1);
  for (const r of rounds) {
    const f = frameOf(r.freezeEnd + 32);
    const alive = { T: [], CT: [] };
    for (let p = 0; p < P; p++) {
      const fl = u8[(f * P + p) * 6 + 2];
      if (fl & FLAG_PRESENT && fl & FLAG_ALIVE) alive[fl & FLAG_CT ? 'CT' : 'T'].push(p);
    }
    r.alive = alive;
  }
  const roundOf = (t) => rounds.findIndex((r) => r.start <= t && t <= r.next);

  const kills = [];
  for (const row of rows(events, 'player_death')) {
    const t = row.tick;
    const a = lookup.get(row.attacker_steamid, row.attacker_name);
    const v = lookup.get(row.user_steamid, row.user_name);
    if (v < 0) continue;
    const asst = lookup.get(row.assister_steamid, row.assister_name);
    const aSide = side(t, a), vSide = side(t, v);
    kills.push({
      tick: t,
      round: roundOf(t),
      attacker: a,
      victim: v,
      assister: asst,
      weapon: str(row.weapon),
      headshot: bool(row.headshot),
      penetrated: int(row.penetrated),
      noscope: bool(row.noscope),
      smoke: bool(row.thrusmoke),
      blind: bool(row.attackerblind),
      air: bool(row.attackerinair),
      flashAssist: bool(row.assistedflash),
      distance: pyRound(num(row.distance), 1),
      attackerSide: aSide,
      victimSide: vSide,
      teamkill: a >= 0 && a !== v && aSide !== null && aSide === vSide,
      pos: posAt(t, v),
      attackerPos: a >= 0 ? posAt(t, a) : null,
    });
  }

  const shots = [];
  for (const row of rows(events, 'weapon_fire')) {
    const p = lookup.get(row.user_steamid, row.user_name);
    if (p >= 0) shots.push([row.tick, p, str(row.weapon).replaceAll('weapon_', '')]);
  }

  const hurts = [];
  for (const row of rows(events, 'player_hurt')) {
    const v = lookup.get(row.user_steamid, row.user_name);
    if (v < 0) continue;
    const a = lookup.get(row.attacker_steamid, row.attacker_name);
    hurts.push([row.tick, a, v, int(row.dmg_health), int(row.health), str(row.hitgroup), str(row.weapon)]);
  }

  const blinds = [];
  for (const row of rows(events, 'player_blind')) {
    const v = lookup.get(row.user_steamid, row.user_name);
    if (v < 0) continue;
    const a = lookup.get(row.attacker_steamid, row.attacker_name);
    blinds.push([row.tick, v, a, pyRound(num(row.blind_duration), 2)]);
  }

  const roundStarts = rounds.map((r) => r.start).sort((a, b) => a - b);
  const nextRoundStart = (t) => roundStarts.find((s) => s > t) ?? t1;
  const effects = buildEffects(events, lookup, tickRate, nextRoundStart);

  const bombTypes = {
    bomb_pickup: 'pickup', bomb_dropped: 'drop', bomb_beginplant: 'beginplant', bomb_planted: 'plant',
    bomb_begindefuse: 'begindefuse', bomb_defused: 'defuse', bomb_exploded: 'explode',
  };
  const typeOrder = Object.values(bombTypes);
  const bomb = [];
  for (const [ev, kind] of Object.entries(bombTypes)) {
    for (const row of rows(events, ev)) {
      const p = lookup.get(row.user_steamid, row.user_name);
      const entry = { tick: row.tick, type: kind, player: p };
      if (p >= 0) entry.pos = posAt(row.tick, p);
      bomb.push(entry);
    }
  }
  bomb.sort((x, y) => x.tick - y.tick || typeOrder.indexOf(x.type) - typeOrder.indexOf(y.type));

  progress(0.7, 'Траектории гранат');
  let grenades = [];
  try {
    grenades = buildGrenades(wasm.grenades(), lookup, step);
  } catch (err) {
    console.warn('grenades', err);
  }

  progress(0.82, 'Статистика');
  const scoreboard = buildScoreboard(wasm, rounds, lookup, players);
  const placeAt = (t, p) => (p < 0 ? '' : places[u8[(frameOf(t) * P + p) * 6 + 5]]);
  for (const k of kills) k.place = placeAt(k.tick, k.victim);
  for (const b of bomb) if (b.type === 'plant') b.place = placeAt(b.tick, b.player);

  const meta = {
    format: FORMAT_VERSION,
    generator: GENERATOR,
    file: fileName,
    map: str(header.map_name) || 'unknown',
    server: str(header.server_name),
    client: str(header.client_name),
    build: str(header.patch_version),
    tickRate,
    parsedAt: Math.floor(Date.now() / 1000),
    parseSeconds: null,
    players,
    weapons,
    places,
    rounds,
    kills,
    shots,
    hurts,
    blinds,
    bomb,
    grenades,
    effects,
    scoreboard,
  };

  const sections = [];
  const parts = [];
  let offset = 0;
  for (const [name, arr, dtype] of [['pos', pos, 'float32'], ['ang', ang, 'int16'], ['u8', u8, 'uint8'], ['money', money, 'uint16'], ['keys', keys, 'uint16']]) {
    sections.push({ name, dtype, offset, bytes: arr.byteLength });
    parts.push([offset, arr]);
    offset += arr.byteLength;
    offset += pyMod(-offset, 8);
  }
  const frames = new Uint8Array(offset);
  for (const [o, arr] of parts) frames.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), o);
  meta.frames = {
    startTick: t0, endTick: t1, step, count: frameCount, players: P, u8Fields: U8_FIELDS,
    keys: KEY_NAMES, keysKnown, sections,
  };

  progress(0.92, 'Поиск хайлайтов');
  meta.highlights = detectHighlights(meta);
  meta.parseSeconds = pyRound((now() - started) / 1000, 2);
  progress(1.0, 'Готово');
  return { meta, frames: frames.buffer };
}

/** Game button mask (BigInt) -> bits of the "keys" section. */
export function keysFromButtons(mask) {
  let k = 0;
  KEY_BUTTONS.forEach(([, bit], i) => { if ((mask >> BigInt(bit)) & 1n) k |= 1 << i; });
  return k;
}

/**
 * Per-row key bits from the single-button columns, and the on-screen keyboard
 * keys those columns cover.
 */
function buttonKeys(c) {
  // key bit for each available button column
  const cols = [];
  for (const [name, bit] of Object.entries(BUTTON_PROPS)) {
    const key = KEY_BUTTONS.findIndex(([, b]) => b === bit);
    if (c[name] && key >= 0) cols.push([c[name], 1 << key]);
  }
  return {
    keysAt: (i) => {
      let k = 0;
      for (const [col, b] of cols) if (colBool(col, i)) k |= b;
      return k;
    },
    known: KEY_BUTTONS.filter(([, bit]) => Object.entries(BUTTON_PROPS).some(([n, b]) => b === bit && c[n]))
      .map(([key]) => key),
  };
}

/**
 * Set KEY_WHEEL around jumps made without the jump button (flat [F][P] arrays).
 * A jump: on the ground, then airborne and at least 8 units higher 6 ticks
 * later. If Space wasn't held from 12 ticks before to 4 ticks after the
 * take-off, the jump came from the mouse wheel; mark it for 8 ticks.
 */
export function markWheelJumps(keys, flags, z, frames, P, step) {
  const rise = Math.max(1, floorDiv(6, step)), back = Math.max(1, floorDiv(12, step));
  const ahead = Math.max(1, floorDiv(4, step)), mark = Math.max(1, floorDiv(8, step));
  if (frames <= rise + 1) return;
  const air = (f, p) => (flags[f * P + p] & FLAG_AIRBORNE) !== 0;
  const alive = (f, p) => (flags[f * P + p] & FLAG_ALIVE) !== 0;
  for (let t = 1; t < frames - rise; t++) {
    for (let p = 0; p < P; p++) {
      if (air(t - 1, p) || !air(t, p) || !alive(t - 1, p) || !alive(t, p)) continue;
      if (!(z[(t + rise) * P + p] - z[(t - 1) * P + p] > 8.0)) continue;
      let space = false;
      for (let g = Math.max(0, t - back); g <= Math.min(frames - 1, t + ahead); g++) {
        if (keys[g * P + p] & (1 << KEY_SPACE)) { space = true; break; }
      }
      if (space) continue;
      for (let g = Math.max(0, t - 1); g < Math.min(frames, t - 1 + mark); g++) keys[g * P + p] |= 1 << KEY_WHEEL;
    }
  }
}

function buildRounds(events, t0, t1) {
  const starts = sortedSet(rows(events, 'round_start').map((r) => r.tick));
  const freezes = sortedSet(rows(events, 'round_freeze_end').map((r) => r.tick));
  const officials = sortedSet(rows(events, 'round_officially_ended').map((r) => r.tick));
  const matchStarts = rows(events, 'begin_new_match').map((r) => r.tick);
  let ends = [];
  const seen = new Set();
  for (const row of rows(events, 'round_end')) {
    // demoparser2 emits a synthetic round_end (no winner, no reason) at the
    // start of some recordings; it is not a played round.
    if (seen.has(row.tick) || (isMissing(row.winner) && isMissing(row.reason))) continue;
    seen.add(row.tick);
    ends.push(row);
  }
  if (matchStarts.length) {
    const ms = matchStarts[matchStarts.length - 1];
    const kept = ends.filter((e) => e.tick > ms);
    if (kept.length) ends = kept;
  }

  const rounds = [];
  let prevEnd = t0;
  ends.forEach((row, i) => {
    const end = row.tick;
    const cands = starts.filter((s) => prevEnd <= s && s <= end);
    const start = cands.length ? cands[cands.length - 1] : prevEnd;
    const fcands = freezes.filter((f) => start <= f && f <= end);
    let winner = str(row.winner).toUpperCase();
    if (winner === 'TERRORIST' || winner === '2') winner = 'T';
    else if (winner === '3') winner = 'CT';
    if (winner !== 'T' && winner !== 'CT') winner = null;
    rounds.push({ num: i + 1, start, freezeEnd: fcands.length ? fcands[0] : start, end, winner, reason: str(row.reason) });
    prevEnd = end;
  });

  // A round still in progress when the recording stopped.
  const tail = starts.filter((s) => s > prevEnd);
  if (tail.length && t1 - tail[tail.length - 1] > 64 * 5) {
    const start = tail[tail.length - 1];
    const fcands = freezes.filter((f) => f >= start);
    rounds.push({ num: rounds.length + 1, start, freezeEnd: fcands.length ? fcands[0] : start, end: t1, winner: null, reason: '' });
  }
  if (!rounds.length) rounds.push({ num: 1, start: t0, freezeEnd: t0, end: t1, winner: null, reason: '' });

  // "next": when the following round starts (end of the after-round period).
  rounds.forEach((r, i) => {
    if (i + 1 < rounds.length) r.next = rounds[i + 1].start;
    else {
      const later = officials.filter((o) => o >= r.end);
      r.next = later.length ? Math.min(t1, later[0]) : t1;
    }
    r.next = Math.max(r.next, r.end);
  });
  return rounds;
}

function buildEffects(events, lookup, tickRate, nextRoundStart) {
  const thrower = (row) => lookup.get(row.user_steamid, row.user_name);
  const xyz = (row) => ['x', 'y', 'z'].map((k) => pyRound(num(row[k]), 1));
  const paired = (startEv, endEv, seconds) => {
    const endsBy = new Map();
    for (const row of rows(events, endEv)) {
      if (isMissing(row.entityid)) continue;
      const k = String(row.entityid);
      if (!endsBy.has(k)) endsBy.set(k, []);
      endsBy.get(k).push(row.tick);
    }
    return rows(events, startEv).map((row) => {
      const start = row.tick;
      const limit = start + Math.trunc(seconds * 2 * tickRate);
      const cands = isMissing(row.entityid) ? [] : (endsBy.get(String(row.entityid)) || []).filter((t) => start < t && t <= limit);
      let end = cands.length ? cands[0] : start + Math.trunc(seconds * tickRate);
      end = Math.min(end, nextRoundStart(start));
      return { start, end, pos: xyz(row), thrower: thrower(row) };
    });
  };
  const points = (ev) => rows(events, ev).map((row) => ({ tick: row.tick, pos: xyz(row), thrower: thrower(row) }));
  return {
    smokes: paired('smokegrenade_detonate', 'smokegrenade_expired', SMOKE_SECONDS),
    infernos: paired('inferno_startburn', 'inferno_expire', INFERNO_SECONDS),
    decoys: paired('decoy_started', 'decoy_detonate', DECOY_SECONDS),
    flashes: points('flashbang_detonate'),
    hes: points('hegrenade_detonate'),
  };
}

function buildGrenades(gr, lookup, step) {
  const n = gr.rows;
  const c = gr.columns;
  if (!n || !c.grenade_type) return [];
  const idx = [];
  for (let i = 0; i < n; i++) {
    const type = colStr(c.grenade_type, i);
    if (!Object.hasOwn(GRENADE_TYPES, type)) continue;
    if (Number.isNaN(c.x[i]) || Number.isNaN(c.y[i]) || Number.isNaN(c.z[i])) continue;
    if (Number.isNaN(c.grenade_entity_id[i])) continue; // pandas groupby drops NaN keys
    idx.push(i);
  }
  const ent = c.grenade_entity_id, tick = c.tick;
  idx.sort((a, b) => ent[a] - ent[b] || tick[a] - tick[b]);
  const groups = new Map();
  for (const i of idx) {
    const k = `${ent[i]}|${colStr(c.grenade_type, i)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const out = [];
  for (const grp of groups.values()) {
    // Entity ids are recycled: split wherever the tick sequence has a gap.
    const segs = [[grp[0]]];
    for (let j = 1; j < grp.length; j++) {
      if (tick[grp[j]] - tick[grp[j - 1]] > 16) segs.push([]);
      segs[segs.length - 1].push(grp[j]);
    }
    for (const part of segs) {
      if (part.length < 2) continue;
      const first = part[0];
      const t0 = tick[first];
      let sampled = part.filter((i) => pyMod(tick[i] - t0, step) === 0);
      if (sampled.length < 2 || tick[sampled[sampled.length - 1]] !== tick[part[part.length - 1]]) {
        const pick = [];
        for (let j = 0; j < part.length; j += step) pick.push(part[j]);
        pick.push(part[part.length - 1]);
        const seenTicks = new Set();
        sampled = pick.filter((i) => (seenTicks.has(tick[i]) ? false : (seenTicks.add(tick[i]), true)));
      }
      const pts = [];
      for (const i of sampled) pts.push(pyRound(c.x[i], 1), pyRound(c.y[i], 1), pyRound(c.z[i], 1));
      out.push({
        type: GRENADE_TYPES[colStr(c.grenade_type, first)],
        thrower: lookup.get(colStr(c.steamid, first), colStr(c.name, first)),
        ticks: sampled.map((i) => tick[i]),
        pts,
      });
    }
  }
  out.sort((a, b) => a.ticks[0] - b.ticks[0]);
  return out;
}

function buildScoreboard(wasm, rounds, lookup, players) {
  const snap = rounds.map((r) => (r.next > r.end ? Math.min(r.end + 64, r.next) : r.end));
  if (!snap.length) return [];
  let sb;
  try {
    sb = wasm.ticks(SCOREBOARD_PROPS, Int32Array.from(sortedSet(snap)));
  } catch (err) {
    console.warn('scoreboard', err);
    return [];
  }
  const c = sb.columns;
  const byTick = new Map();
  for (let i = 0; i < sb.rows; i++) {
    const t = c.tick[i];
    if (!byTick.has(t)) byTick.set(t, []);
    byTick.get(t).push(i);
  }
  const clans = new Map();
  const iv = (col, i) => (col ? Math.trunc(Number.isNaN(col[i]) ? 0 : col[i]) : 0);
  const out = rounds.map((r, ri) => {
    const t = snap[ri];
    const stats = new Array(players.length).fill(null);
    for (const i of byTick.get(t) || []) {
      const p = lookup.get(colStr(c.steamid, i), colStr(c.name, i));
      if (p < 0) continue;
      stats[p] = [iv(c.kills_total, i), iv(c.deaths_total, i), iv(c.assists_total, i), iv(c.damage_total, i),
        iv(c.team_rounds_total, i), iv(c.mvps, i), iv(c.score, i)];
      const clan = str(colStr(c.team_clan_name, i));
      if (clan) {
        if (!clans.has(p)) clans.set(p, new Map());
        const m = clans.get(p);
        m.set(clan, (m.get(clan) || 0) + 1);
      }
    }
    return { round: r.num, tick: t, stats };
  });
  for (const [p, m] of clans) {
    let best = null;
    for (const [k, v] of m) if (best === null || v > best[1]) best = [k, v];
    players[p].clan = best[0];
  }
  return out;
}
