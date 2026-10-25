// Shared helpers: colors, formatting, weapon names, world <-> scene coordinates.

export const COLORS = {
  T: '#e8a33d',
  CT: '#5aa0e6',
  Tdark: '#7a5418',
  CTdark: '#244f7c',
};

// Source is Z-up (x, y, z); three.js is Y-up. world(x, y, z) -> scene(x, z, -y)
export function toScene(x, y, z, out) {
  out.set(x, z, -y);
  return out;
}

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpAngle(a, b, t) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

export function fmtTime(seconds) {
  seconds = Math.max(0, seconds);
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtMoney(v) {
  return '$' + v.toLocaleString('en-US');
}

export function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' ГБ';
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' МБ';
  return Math.max(1, Math.round(n / 1e3)) + ' КБ';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const WEAPONS = {
  ak47: 'AK-47', m4a1: 'M4A4', m4a1_silencer: 'M4A1-S', m4a1_silencer_off: 'M4A1-S', awp: 'AWP',
  deagle: 'Desert Eagle', usp_silencer: 'USP-S', usp_silencer_off: 'USP-S', glock: 'Glock-18',
  hkp2000: 'P2000', p250: 'P250', tec9: 'Tec-9', fiveseven: 'Five-SeveN', cz75a: 'CZ75-Auto',
  elite: 'Dual Berettas', revolver: 'R8', mac10: 'MAC-10', mp9: 'MP9', mp7: 'MP7', mp5sd: 'MP5-SD',
  ump45: 'UMP-45', p90: 'P90', bizon: 'PP-Bizon', famas: 'FAMAS', galilar: 'Galil AR', sg556: 'SG 553',
  aug: 'AUG', ssg08: 'SSG 08', scar20: 'SCAR-20', g3sg1: 'G3SG1', nova: 'Nova', xm1014: 'XM1014',
  mag7: 'MAG-7', sawedoff: 'Sawed-Off', m249: 'M249', negev: 'Negev', hegrenade: 'HE', inferno: 'Molotov',
  molotov: 'Molotov', incgrenade: 'Incendiary', flashbang: 'Flash', smokegrenade: 'Smoke', decoy: 'Decoy',
  taser: 'Zeus', world: 'мир', planted_c4: 'C4', c4: 'C4',
};

export function isKnife(raw) {
  raw = (raw || '').toLowerCase();
  return raw.includes('knife') || raw.startsWith('bayonet') || raw.includes('karambit') || raw.includes('dagger');
}

export function weaponName(raw) {
  raw = (raw || '').replace(/^weapon_/, '');
  if (isKnife(raw)) return 'Нож';
  return WEAPONS[raw] || raw;
}

const NO_TRACER = /knife|bayonet|grenade|flashbang|molotov|incgrenade|decoy|c4|taser|healthshot|smoke|inferno/i;
export function firesBullets(raw) {
  return !NO_TRACER.test(raw || '');
}

export function sideOf(flags) {
  return flags & 4 ? 'CT' : 'T';
}

export async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch (_) { /* not json */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return res.json();
}

let toastTimer = null;
export function toast(message, kind = 'info', ms = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// -- weapon / killfeed icons ------------------------------------------------------

const ICON_BY_WEAPON = {
  ak47: 'ak47', 'ak-47': 'ak47', galilar: 'galil', 'galil ar': 'galil',
  m4a1: 'm4', m4a4: 'm4', m4a1_silencer: 'm4', m4a1_silencer_off: 'm4', 'm4a1-s': 'm4',
  famas: 'famas', aug: 'aug', sg556: 'aug', 'sg 553': 'aug',
  awp: 'sniper', ssg08: 'sniper', 'ssg 08': 'sniper', scar20: 'auto_sniper', 'scar-20': 'auto_sniper', g3sg1: 'auto_sniper',
  glock: 'glock', 'glock-18': 'glock', usp_silencer: 'usp', usp_silencer_off: 'usp', 'usp-s': 'usp',
  hkp2000: 'usp', p2000: 'usp', p250: 'pistol', fiveseven: 'pistol', 'five-seven': 'pistol', elite: 'pistol',
  'dual berettas': 'pistol', deagle: 'deagle', 'desert eagle': 'deagle', revolver: 'revolver', 'r8 revolver': 'revolver',
  tec9: 'tec9', 'tec-9': 'tec9', cz75a: 'cz75', 'cz75-auto': 'cz75',
  mac10: 'mac10', 'mac-10': 'mac10', mp9: 'mp9', mp7: 'mp7', mp5sd: 'mp5', 'mp5-sd': 'mp5', ump45: 'ump', 'ump-45': 'ump',
  p90: 'p90', bizon: 'bizon', 'pp-bizon': 'bizon',
  nova: 'shotgun', xm1014: 'shotgun', mag7: 'sawedoff', 'mag-7': 'sawedoff', sawedoff: 'sawedoff', 'sawed-off': 'sawedoff',
  m249: 'lmg', negev: 'lmg',
  taser: 'taser', 'zeus x27': 'taser',
  hegrenade: 'he', 'high explosive grenade': 'he', flashbang: 'flash', smokegrenade: 'smoke', 'smoke grenade': 'smoke',
  inferno: 'molotov', molotov: 'molotov', incgrenade: 'molotov', 'incendiary grenade': 'molotov',
  decoy: 'decoy', 'decoy grenade': 'decoy', c4: 'c4', planted_c4: 'c4', 'c4 explosive': 'c4', world: 'world',
};

/** Icon key (see icons.js) for an event weapon name or a display name. */
export function weaponIcon(raw) {
  const name = (raw || '').toLowerCase().replace(/^weapon_/, '').trim();
  if (!name) return null;
  if (isKnife(name) || name.startsWith('knife') || name === 'bayonet') return 'knife';
  return ICON_BY_WEAPON[name] || null;
}

/** Inline SVG markup for an icon, ``height`` px tall. */
export function iconSvg(icons, key, height = 14, color = 'currentColor') {
  const ic = icons[key];
  if (!ic) return '';
  const w = Math.round((ic.w / ic.h) * height);
  return `<svg class="icon" viewBox="0 0 ${ic.w} ${ic.h}" width="${w}" height="${height}" aria-hidden="true"><path fill="${color}" d="${ic.d}"/></svg>`;
}
