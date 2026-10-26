// Port of cs2demo/highlights.py (keep the two in sync): finds clip-worthy
// moments in a parsed demo's meta. Pure JS, no DOM: runs in the parse worker.
//
//  multikill – several kills by one player in a round, close in time (2K…ACE)
//  clutch    – a won 1vX situation (merged with the clutcher's kills)
//  kill      – a single kill that is special enough on its own

import { pyCapitalize, pyRound } from './pyutil.js';

export const DEFAULTS = {
  pre: 3.0, // seconds before the first kill
  post: 2.5, // seconds after the last kill
  max_gap: 15.0, // kills further apart than this start a new clip
  max_span: 40.0, // longest stretch of kills kept in one clip
  max_clip: 75.0, // hard cap on clip length
  min_score: 20.0, // drop anything scoring lower
};

const WEAPON_NAMES = {
  ak47: 'AK-47', m4a1: 'M4A4', m4a1_silencer: 'M4A1-S', m4a1_silencer_off: 'M4A1-S', awp: 'AWP',
  deagle: 'Desert Eagle', usp_silencer: 'USP-S', usp_silencer_off: 'USP-S', glock: 'Glock-18',
  hkp2000: 'P2000', p250: 'P250', tec9: 'Tec-9', fiveseven: 'Five-SeveN', cz75a: 'CZ75-Auto',
  elite: 'Dual Berettas', revolver: 'R8 Revolver', mac10: 'MAC-10', mp9: 'MP9', mp7: 'MP7',
  mp5sd: 'MP5-SD', ump45: 'UMP-45', p90: 'P90', bizon: 'PP-Bizon', famas: 'FAMAS', galilar: 'Galil AR',
  sg556: 'SG 553', aug: 'AUG', ssg08: 'SSG 08', scar20: 'SCAR-20', g3sg1: 'G3SG1', nova: 'Nova',
  xm1014: 'XM1014', mag7: 'MAG-7', sawedoff: 'Sawed-Off', m249: 'M249', negev: 'Negev', hegrenade: 'HE',
  inferno: 'Molotov', molotov: 'Molotov', incgrenade: 'Incendiary', taser: 'Zeus x27', world: 'мир',
  planted_c4: 'C4',
};

const SNIPERS = new Set(['awp', 'ssg08', 'scar20', 'g3sg1']);
const MULTI_BASE = { 1: 6, 2: 22, 3: 45, 4: 70, 5: 100 };
const CLUTCH_BONUS = { 1: 18, 2: 40, 3: 60, 4: 80, 5: 100 };

export function isKnife(raw) {
  raw = (raw || '').toLowerCase();
  return raw.startsWith('knife') || raw.startsWith('bayonet') || raw.includes('knife');
}

export function weaponName(raw) {
  raw = (raw || '').replaceAll('weapon_', '');
  if (isKnife(raw)) return 'Нож';
  if (Object.hasOwn(WEAPON_NAMES, raw)) return WEAPON_NAMES[raw];
  return [...raw].length <= 4 ? raw.toUpperCase() : pyCapitalize(raw);
}

/** Counter with Python's insertion-ordered most_common(). */
class Counter extends Map {
  add(key, n = 1) { this.set(key, (this.get(key) || 0) + n); }
  mostCommon() {
    let best = null;
    for (const [k, v] of this) if (best === null || v > best[1]) best = [k, v];
    return best;
  }
}

function killExtras(k) {
  let score = 0;
  const tags = [];
  const weapon = (k.weapon || '').toLowerCase();
  if (k.noscope && SNIPERS.has(weapon)) { score += 14; tags.push('ноускоп'); }
  if (k.smoke) { score += 8; tags.push('через дым'); }
  if (k.penetrated) { score += 8; tags.push('прострел'); }
  if (k.blind) { score += 12; tags.push('ослеплён'); }
  if (k.air) { score += SNIPERS.has(weapon) ? 12 : 8; tags.push('в прыжке'); }
  if (isKnife(weapon)) { score += 20; tags.push('нож'); } else if (weapon === 'taser') { score += 15; tags.push('зевс'); }
  if ((k.distance || 0) >= 40) { score += 4; tags.push('дальний'); }
  return [score, tags];
}

export function scoreKills(kills, tickRate) {
  const n = kills.length;
  if (n === 0) return [0, []];
  let score = MULTI_BASE[n] ?? 100 + 20 * (n - 5);
  const tags = [];
  if (n >= 5) tags.push('ACE');
  else if (n >= 2) tags.push(`${n}K`);
  const hs = kills.filter((k) => k.headshot).length;
  score += 2 * hs;
  if (hs >= 2 && hs === n) tags.push(`HS ×${hs}`);
  else if (hs === 1 && n === 1) tags.push('HS');
  const extra = new Counter();
  for (const k of kills) {
    const [s, t] = killExtras(k);
    score += s;
    for (const tag of t) extra.add(tag);
  }
  if (n >= 2) {
    const span = (kills[n - 1].tick - kills[0].tick) / tickRate;
    if (span <= 2.5) { score += 15; tags.push('молниеносно'); } else if (span <= 6) { score += 8; tags.push('быстро'); }
  }
  for (const [tag, count] of extra) tags.push(count === 1 ? tag : `${tag} ×${count}`);
  return [Math.trunc(score), tags];
}

function splitSegments(ticks, rate, maxGap, maxSpan) {
  if (!ticks.length) return [];
  const groups = [[0]];
  for (let i = 1; i < ticks.length; i++) {
    if ((ticks[i] - ticks[i - 1]) / rate > maxGap) groups.push([i]);
    else groups[groups.length - 1].push(i);
  }
  const splitLong = (group) => {
    if (group.length < 2 || (ticks[group[group.length - 1]] - ticks[group[0]]) / rate <= maxSpan) return [group];
    // max((gap, j)): the largest gap, the last one on ties
    let cut = 0, best = -Infinity;
    for (let j = 0; j < group.length - 1; j++) {
      const gap = ticks[group[j + 1]] - ticks[group[j]];
      if (gap >= best) { best = gap; cut = j; }
    }
    return [...splitLong(group.slice(0, cut + 1)), ...splitLong(group.slice(cut + 1))];
  };
  return groups.flatMap(splitLong);
}

/** 1vX situations (won or lost) per round. */
export function detectClutches(meta) {
  const rounds = meta.rounds || [];
  const kills = meta.kills || [];
  const byRound = new Map();
  kills.forEach((k, i) => {
    if ((k.round ?? -1) >= 0) {
      if (!byRound.has(k.round)) byRound.set(k.round, []);
      byRound.get(k.round).push(i);
    }
  });
  const out = [];
  rounds.forEach((r, rIdx) => {
    if (r.knife) return;
    const startAlive = r.alive || {};
    const alive = { T: new Set(startAlive.T || []), CT: new Set(startAlive.CT || []) };
    if (!alive.T.size || !alive.CT.size) return;
    let clutch = null;
    const idxs = [...(byRound.get(rIdx) || [])].sort((a, b) => kills[a].tick - kills[b].tick);
    for (const ki of idxs) {
      const k = kills[ki];
      if (k.tick < (r.freezeEnd ?? r.start)) continue;
      alive.T.delete(k.victim);
      alive.CT.delete(k.victim);
      if (clutch !== null) continue;
      for (const [side, other] of [['T', 'CT'], ['CT', 'T']]) {
        if (alive[side].size === 1 && alive[other].size >= 1) {
          // Both sides at 1 on the same kill: a plain 1v1, the killer's side clutches.
          if (alive[other].size === 1 && k.attackerSide !== side) continue;
          clutch = { round: rIdx, player: [...alive[side]][0], side, vs: alive[other].size, startTick: k.tick };
          break;
        }
      }
    }
    if (clutch === null) return;
    clutch.won = r.winner === clutch.side;
    clutch.kills = (byRound.get(rIdx) || []).filter((i) =>
      kills[i].attacker === clutch.player && kills[i].tick >= clutch.startTick
      && !kills[i].teamkill && kills[i].victim !== clutch.player);
    out.push(clutch);
  });
  return out;
}

function slug(text) {
  const ascii = [...text].filter((c) => c.codePointAt(0) < 128).join('');
  const s = ascii.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return s.slice(0, 24) || 'player';
}

const isSubset = (a, b) => [...a].every((x) => b.has(x));
const intersects = (a, b) => a.some((x) => b.has(x));

export function detectHighlights(meta, options = {}) {
  const opts = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options)) if (v !== null && v !== undefined) opts[k] = Number(v);
  const rate = Number(meta.tickRate || 64.0);
  const rounds = meta.rounds || [];
  const kills = meta.kills || [];
  const players = meta.players || [];

  const groups = new Map();
  kills.forEach((k, i) => {
    const a = k.attacker ?? -1;
    if (a < 0 || a === k.victim || k.teamkill || (k.round ?? -1) < 0) return;
    if (k.round < rounds.length && rounds[k.round].knife) return;
    const key = `${k.round},${a}`;
    if (!groups.has(key)) groups.set(key, { round: k.round, player: a, idxs: [] });
    groups.get(key).idxs.push(i);
  });

  let candidates = [];
  for (const { round, player, idxs } of groups.values()) {
    idxs.sort((x, y) => kills[x].tick - kills[y].tick);
    const ticks = idxs.map((i) => kills[i].tick);
    for (const seg of splitSegments(ticks, rate, opts.max_gap, opts.max_span)) {
      const segKills = seg.map((j) => idxs[j]);
      candidates.push({
        kind: segKills.length >= 2 ? 'multikill' : 'kill',
        round, player, kills: segKills, roundKills: idxs.length, clutch: null,
      });
    }
  }

  for (const c of detectClutches(meta)) {
    if (!c.won) continue;
    // Fold the clutcher's overlapping kill segments into one clutch clip,
    // unless that would make it longer than the clip cap.
    const ckills = new Set(c.kills);
    let overlapping = candidates.filter((cand) => cand.round === c.round && cand.player === c.player
      && intersects(cand.kills, ckills));
    const union = new Set(c.kills);
    for (const cand of overlapping) for (const i of cand.kills) union.add(i);
    let merged = [...union].sort((a, b) => kills[a].tick - kills[b].tick);
    if (merged.length && (kills[merged[merged.length - 1]].tick - kills[merged[0]].tick) / rate > opts.max_clip) {
      merged = [...c.kills].sort((a, b) => kills[a].tick - kills[b].tick);
      const m = new Set(merged);
      overlapping = overlapping.filter((cand) => isSubset(cand.kills, m));
    }
    candidates = candidates.filter((cand) => !overlapping.includes(cand));
    candidates.push({
      kind: 'clutch', round: c.round, player: c.player, kills: merged,
      roundKills: groups.get(`${c.round},${c.player}`)?.idxs.length ?? 0, clutch: c,
    });
  }

  const out = [];
  for (const cand of candidates) {
    const h = finalise(cand, rounds, kills, players, rate, opts);
    if (h && h.score >= opts.min_score) out.push(h);
  }
  out.sort((a, b) => a.start - b.start);
  const used = new Counter();
  for (const h of out) {
    used.add(h.id);
    if (used.get(h.id) > 1) h.id = `${h.id}-${used.get(h.id)}`;
  }
  return out;
}

function finalise(cand, rounds, kills, players, rate, opts) {
  const r = cand.round >= 0 && cand.round < rounds.length ? rounds[cand.round] : null;
  const ks = cand.kills.map((i) => kills[i]);
  const clutch = cand.clutch;
  if (!ks.length && !clutch) return null;

  let [score, tags] = scoreKills(ks, rate);
  const pre = Math.trunc(opts.pre * rate), post = Math.trunc(opts.post * rate);
  let start, end;
  if (ks.length) { start = ks[0].tick - pre; end = ks[ks.length - 1].tick + post; } else { start = clutch.startTick - pre; end = clutch.startTick + post; }
  if (clutch) {
    score += CLUTCH_BONUS[clutch.vs] ?? 100;
    tags.unshift(`клатч 1v${clutch.vs}`);
    start = Math.min(start, clutch.startTick - Math.trunc(2 * rate));
    if (r && ['bomb_defused', 'target_bombed', 'bomb_exploded'].includes(r.reason)) {
      end = Math.max(end, r.end + Math.trunc(1.5 * rate));
    }
  }
  if (r) {
    start = Math.max(start, r.start);
    end = Math.min(end, r.next ?? r.end);
  }
  const maxClip = Math.trunc(opts.max_clip * rate);
  if (end - start > maxClip) start = end - maxClip;
  if (end <= start) return null;

  const p = cand.player;
  const pname = p >= 0 && p < players.length ? players[p].name : '?';
  const weapons = new Counter();
  for (const k of ks) weapons.add(weaponName(k.weapon || ''));
  const weapon = weapons.size ? weapons.mostCommon()[0] : '';
  const n = ks.length;
  let label, short;
  if (cand.kind === 'clutch') {
    label = `Клатч 1v${clutch.vs}`;
    if (n >= 2) label += ` + ${n >= 5 ? 'ACE' : `${n}K`}`;
    short = `clutch1v${clutch.vs}`;
  } else if (n >= 2) {
    label = n >= 5 ? 'ACE' : `${n}K`;
    short = n >= 5 ? 'ace' : `${n}k`;
  } else {
    const special = tags.filter((t) => t !== 'HS');
    label = special.length ? pyCapitalize(special[0]) : 'Килл';
    short = 'kill';
  }
  if ((cand.roundKills ?? n) > n && cand.kind !== 'clutch') tags.push(`за раунд: ${cand.roundKills}K`);
  const side = (ks.length ? ks[0].attackerSide : null) || (clutch || {}).side || null;
  const roundNum = r ? r.num : cand.round + 1;
  const title = `${label} — ${pname}` + (weapon ? ` (${weapon})` : '');
  return {
    id: `r${String(roundNum).padStart(2, '0')}-${slug(pname)}-${short}`,
    kind: cand.kind,
    player: p,
    playerName: pname,
    side,
    round: roundNum,
    roundIndex: cand.round,
    start: Math.trunc(start),
    end: Math.trunc(end),
    duration: pyRound((end - start) / rate, 2),
    kills: cand.kills,
    killTicks: ks.map((k) => k.tick),
    score: Math.trunc(score),
    title,
    label,
    weapon,
    tags,
    clutch: clutch ? { vs: clutch.vs, startTick: clutch.startTick } : null,
  };
}
