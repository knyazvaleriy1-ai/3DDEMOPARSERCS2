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
