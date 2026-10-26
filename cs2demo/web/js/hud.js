// 2D overlay drawn on a canvas: score/timer, killfeed, first-person HUD,
// flashbang/scope overlays and clip title cards. The same canvas is
// composited into recorded clips, so everything visible here ends up in them.
import { COLORS, fmtTime, weaponIcon, weaponName } from './util.js';
import { ICONS } from './icons.js';

const pathCache = new Map();
function iconPath(key) {
  let p = pathCache.get(key);
  if (!p) {
    p = new Path2D(ICONS[key].d);
    pathCache.set(key, p);
  }
  return p;
}

// Side of the assister at the time of the kill (assists can come from either team in theory).
function sideOfPlayer(k, demo) {
  const as = demo.state(k.assister, k.tick);
  return as.present ? as.side : k.attackerSide || 'T';
}

const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
const ROUND_SECONDS = 115;
const BOMB_SECONDS = 40;

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = { killfeed: true, scorebar: true };
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(info) {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    if (!info || !info.demo) return;
    const s = Math.max(0.5, H / 720);
    this.s = s;

    if (info.pov && info.povState && info.povState.alive) {
      if (info.povState.scoped && /awp|ssg|scar|g3sg1|sg 553|aug/i.test(info.povState.weapon)) this._scope(W, H, s);
      else this._crosshair(W, H, s);
    }
    if (info.blind > 0.01) {
      c.fillStyle = `rgba(255,255,255,${Math.min(1, info.blind)})`;
      c.fillRect(0, 0, W, H);
    }
    if (this.options.scorebar) this._scorebar(info, W, s);
    if (this.options.killfeed) this._killfeed(info, W, s);
    if (info.pov && info.povState && info.povState.present) this._povHud(info, W, H, s);
    this._kbTop = null;
    if (info.keys) this._keyboard(info, W, H, s);
    if (info.clip) this._clipCard(info, W, H, s);
  }

  _text(str, x, y, size, color, align = 'left', weight = 600) {
    const c = this.ctx;
    c.font = `${weight} ${size}px ${FONT}`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.fillStyle = color;
    c.fillText(str, x, y);
    return c.measureText(str).width;
  }

  _panel(x, y, w, h, r, fill, stroke) {
    const c = this.ctx;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fillStyle = fill;
    c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = Math.max(1, 1.5 * this.s); c.stroke(); }
  }

  _scorebar(info, W, s) {
    const { demo, tick, round, score, alive, bomb } = info;
    if (!round) return;
    const rate = demo.tickRate;
    const w = 300 * s, h = 46 * s, x = W / 2 - w / 2, y = 8 * s;
    this._panel(x, y, w, h, 8 * s, 'rgba(10,12,15,0.78)');
    // Scores
    this._panel(x, y, 70 * s, h, 8 * s, 'rgba(232,163,61,0.22)');
    this._panel(x + w - 70 * s, y, 70 * s, h, 8 * s, 'rgba(90,160,230,0.22)');
    this._text(String(score.T), x + 35 * s, y + h / 2, 24 * s, COLORS.T, 'center', 700);
    this._text(String(score.CT), x + w - 35 * s, y + h / 2, 24 * s, COLORS.CT, 'center', 700);
    // Alive pips
    for (const [side, x0, dir] of [['T', x + 76 * s, 1], ['CT', x + w - 76 * s, -1]]) {
      const n = alive[side] || 0;
      this._text(`${n}`, x0 + dir * 4 * s, y + h - 9 * s, 11 * s, COLORS[side], dir > 0 ? 'left' : 'right', 600);
    }
    // Clock
    let clock, color = '#e7e9ee';
    if (bomb && bomb.state === 'planted') {
      const left = BOMB_SECONDS - (tick - bomb.plantTick) / rate;
      clock = `C4 ${fmtTime(Math.max(0, left))}`;
      color = '#ff6b6e';
    } else if (bomb && bomb.state === 'defused' && tick >= bomb.endTick) {
      clock = 'Разминир.'; color = COLORS.CT;
    } else if (tick > round.end && round.winner) {
      clock = `Победа ${round.winner}`;
      color = COLORS[round.winner];
    } else if (tick < round.freezeEnd) {
      clock = `Закупка ${fmtTime((round.freezeEnd - tick) / rate)}`;
      color = '#9aa3ad';
    } else {
      clock = fmtTime(ROUND_SECONDS - (tick - round.freezeEnd) / rate);
    }
    this._text(clock, W / 2, y + 18 * s, 18 * s, color, 'center', 700);
    this._text(`Раунд ${round.num}`, W / 2, y + 36 * s, 11 * s, '#8b93a1', 'center', 500);
  }

  /** Draw icon ``key`` with its left edge at x, vertically centred on y. Returns width. */
  _icon(key, x, y, height, color = '#e7e9ee') {
    const ic = ICONS[key];
    if (!ic) return 0;
    const c = this.ctx;
    const k = height / ic.h;
    c.save();
    c.translate(x, y - height / 2);
    c.scale(k, k);
    c.fillStyle = color;
    c.fill(iconPath(key));
    c.restore();
    if (key === 'noscope') {
      // CS-style "no scope": the crosshair struck through.
      c.save();
      c.strokeStyle = color;
      c.lineWidth = Math.max(1.5, height * 0.12);
      c.beginPath();
      c.moveTo(x + height * 0.05, y + height * 0.45);
      c.lineTo(x + height * 0.95, y - height * 0.45);
      c.stroke();
      c.restore();
    }
    return ic.w * k;
  }

  _iconWidth(key, height) {
    const ic = ICONS[key];
    return ic ? (ic.w / ic.h) * height : 0;
  }

  _killfeed(info, W, s) {
    const { demo, tick, roundStart } = info;
    const rate = demo.tickRate;
    const window = 6 * rate;
    const kills = demo.killsBetween(Math.max(roundStart ?? 0, tick - window), tick).slice(-6);
    let y = 10 * s;
    const c = this.ctx;
    const size = 14 * s;
    const gap = 7 * s, pad = 10 * s;
    const weaponH = 17 * s, modH = 16 * s;
    for (const k of kills) {
      const a = k.attacker >= 0 && k.attacker !== k.victim ? demo.players[k.attacker].name : '';
      const v = demo.players[k.victim].name;
      const assist = k.assister >= 0 ? demo.players[k.assister].name : '';
      // [blind] attacker [+ assister] weapon [noscope] [smoke] [wallbang] [headshot] [air] victim
      const parts = [];
      if (k.blind) parts.push({ icon: 'blind', h: modH, color: '#ffffff' });
      if (a) parts.push({ text: a, color: COLORS[k.attackerSide || 'T'], size, weight: 600 });
      if (assist) {
        parts.push({ text: '+', color: '#d5d9e0', size, weight: 600 });
        if (k.flashAssist) parts.push({ icon: 'assist', h: modH * 0.9, color: '#ffffff' });
        parts.push({ text: assist, color: COLORS[sideOfPlayer(k, demo)], size: size * 0.9, weight: 500 });
      }
      const wKey = weaponIcon(k.weapon);
      if (wKey) parts.push({ icon: wKey, h: weaponH, color: '#ffffff', wide: true });
      else parts.push({ text: weaponName(k.weapon), color: '#d5d9e0', size: 12 * s, weight: 500 });
      if (k.noscope) parts.push({ icon: 'noscope', h: modH, color: '#ffffff' });
      if (k.smoke) parts.push({ icon: 'thrusmoke', h: modH, color: '#ffffff' });
      if (k.penetrated) parts.push({ icon: 'wallbang', h: modH, color: '#ffffff' });
      if (k.headshot) parts.push({ icon: 'headshot', h: modH * 1.05, color: '#ffffff' });
      if (k.air) parts.push({ icon: 'air', h: modH, color: '#ffffff' });
      parts.push({ text: v, color: COLORS[k.victimSide || 'CT'], size, weight: 600 });

      for (const p of parts) {
        if (p.text !== undefined) {
          c.font = `${p.weight} ${p.size}px ${FONT}`;
          p.w = c.measureText(p.text).width;
        } else {
          p.w = this._iconWidth(p.icon, p.h);
        }
      }
      const total = pad * 2 + parts.reduce((acc, p) => acc + p.w, 0) + gap * (parts.length - 1);
      const x = W - 10 * s - total;
      const rowH = 28 * s;
      const involved = info.focus >= 0 && (k.attacker === info.focus || k.victim === info.focus);
      const alpha = Math.min(1, (window - (tick - k.tick)) / rate);
      c.globalAlpha = Math.max(0, alpha);
      this._panel(x, y, total, rowH, 5 * s, involved ? 'rgba(40,10,12,0.82)' : 'rgba(10,12,15,0.78)', involved ? '#e5484d' : null);
      let cx = x + pad;
      const cy = y + rowH / 2;
      for (const p of parts) {
        if (p.text !== undefined) this._text(p.text, cx, cy, p.size, p.color, 'left', p.weight);
        else this._icon(p.icon, cx, cy, p.h, p.color);
        cx += p.w + gap;
      }
      c.globalAlpha = 1;
      y += rowH + 4 * s;
    }
  }

  _povHud(info, W, H, s) {
    const st = info.povState;
    const name = info.demo.players[info.povPlayer]?.name || '';
    const side = st.side;
    const y = H - 52 * s;
    // health / armor
    this._panel(12 * s, y, 190 * s, 40 * s, 6 * s, 'rgba(10,12,15,0.72)');
    this._text('HP', 22 * s, y + 20 * s, 12 * s, '#8b93a1');
    this._text(String(st.alive ? st.hp : 0), 46 * s, y + 20 * s, 24 * s, st.hp > 30 ? '#e7e9ee' : '#ff6b6e', 'left', 700);
    this._text(st.helmet ? 'Броня+шлем' : 'Броня', 100 * s, y + 13 * s, 10 * s, '#8b93a1');
    this._text(String(st.armor), 100 * s, y + 28 * s, 16 * s, '#e7e9ee', 'left', 700);
    // name + place
    const label = `${name}${st.place ? '  ·  ' + st.place : ''}`;
    const c = this.ctx;
    c.font = `600 ${15 * s}px ${FONT}`;
    const lw = c.measureText(label).width + 24 * s;
    this._panel(W / 2 - lw / 2, y + 4 * s, lw, 32 * s, 6 * s, 'rgba(10,12,15,0.72)', COLORS[side]);
    this._text(label, W / 2, y + 20 * s, 15 * s, COLORS[side], 'center');
    // weapon + money
    const weapon = st.alive ? st.weapon : 'мёртв';
    this._panel(W - 202 * s, y, 190 * s, 40 * s, 6 * s, 'rgba(10,12,15,0.72)');
    this._text(weapon, W - 192 * s, y + 13 * s, 14 * s, '#e7e9ee');
    const wKey = st.alive ? weaponIcon(st.weapon) : null;
    if (wKey) {
      // Weapon silhouette above the panel, at most 110px wide.
      let ih = 24 * s;
      const maxW = 110 * s;
      if (this._iconWidth(wKey, ih) > maxW) ih *= maxW / this._iconWidth(wKey, ih);
      this._icon(wKey, W - 16 * s - this._iconWidth(wKey, ih), y - 8 * s - ih / 2, ih, 'rgba(255,255,255,0.92)');
    }
    this._text('$' + st.money.toLocaleString('en-US'), W - 192 * s, y + 29 * s, 12 * s, '#8fd18f', 'left', 600);
    if (st.defuser) this._text('кусачки', W - 22 * s, y + 29 * s, 11 * s, '#8b93a1', 'right', 500);

    // multi-kill banner for the POV player's kills in this round
    const rate = info.demo.tickRate;
    let count = 0, lastTick = -1;
    for (const k of info.demo.killsBetween(info.roundStart ?? 0, info.tick)) {
      if (k.attacker === info.povPlayer && !k.teamkill && k.victim !== k.attacker) { count++; lastTick = k.tick; }
    }
    if (count > 0 && info.tick - lastTick < 1.4 * rate) {
      const age = (info.tick - lastTick) / rate;
      const text = count >= 5 ? 'ACE' : count === 1 ? '+1' : `${count}K`;
      c.globalAlpha = Math.min(1, (1.4 - age) / 0.4);
      const size = (34 + 10 * Math.max(0, 1 - age * 5)) * s;
      this._text(text, W / 2, H * 0.68, size, count >= 3 ? '#ffd34d' : '#ffffff', 'center', 800);
      c.globalAlpha = 1;
    }
  }

  /** On-screen keyboard: the keys and mouse buttons the followed player holds. */
  _keyboard(info, W, H, s) {
    const k = info.keys;
    const c = this.ctx;
    const u = 30 * s, g = 4 * s; // key size, gap
    const kw = 4 * u + 3 * g, mw = 1.7 * u, bh = 3 * u + 2 * g;
    const x0 = 12 * s;
    const y0 = (info.pov ? H - 64 * s : H - 12 * s) - bh;
    this._kbTop = y0 - (info.pov ? 0 : 18 * s);
    if (k.player < 0 || !k.keys) {
      const msg = k.player < 0 ? 'Клавиатура: выберите игрока (клик по нику)' : 'Нет данных о клавишах — откройте демо заново';
      c.font = `500 ${12 * s}px ${FONT}`;
      this._panel(x0, y0 + bh - 26 * s, c.measureText(msg).width + 16 * s, 26 * s, 6 * s, 'rgba(10,12,15,0.72)');
      this._text(msg, x0 + 8 * s, y0 + bh - 13 * s, 12 * s, '#c9cfda', 'left', 500);
      return;
    }
    const held = k.alive ? k.keys : {};
    const key = (label, x, y, w, on, known = true) => {
      this._panel(x, y, w, u, 5 * s, on ? 'rgba(240,160,32,0.95)' : 'rgba(10,12,15,0.62)', on ? null : 'rgba(255,255,255,0.16)');
      const size = (label.length > 2 ? 10 : 14) * s;
      this._text(label, x + w / 2, y + u / 2 + 0.5 * s, size, on ? '#141414' : known ? '#c9cfda' : '#5b626e', 'center', 700);
    };
    const col = (i) => x0 + i * (u + g);
    const row = (j) => y0 + j * (u + g);
    // Keys without data (older demoparser2) are drawn dimmed.
    const kn = (name) => k.known.has(name);
    for (const [name, i, j] of [['TAB', 0, 0], ['W', 1, 0], ['E', 2, 0], ['R', 3, 0],
      ['A', 0, 1], ['S', 1, 1], ['D', 2, 1], ['F', 3, 1]]) {
      key(name, col(i), row(j), u, held[name], kn(name));
    }
    const wShift = 1.5 * u + 0.5 * g, wCtrl = u, wSpace = kw - wShift - wCtrl - 2 * g;
    key('SHIFT', col(0), row(2), wShift, held.SHIFT, kn('SHIFT'));
    key('CTRL', col(0) + wShift + g, row(2), wCtrl, held.CTRL, kn('CTRL'));
    key('SPACE', col(0) + wShift + wCtrl + 2 * g, row(2), wSpace, held.SPACE, kn('SPACE'));

    // Mouse: buttons, wheel (jumps bound to it) and movement.
    const mx = x0 + kw + 2 * g, my = y0;
    this._panel(mx, my, mw, bh, mw / 2.2, 'rgba(10,12,15,0.62)', 'rgba(255,255,255,0.16)');
    const bh2 = 1.25 * u;
    c.save();
    c.beginPath();
    c.roundRect(mx, my, mw, bh, mw / 2.2);
    c.clip();
    const lmb = held.LMB || (k.alive && k.shot);
    c.fillStyle = lmb ? 'rgba(240,160,32,0.95)' : 'rgba(255,255,255,0.05)';
    c.fillRect(mx, my, mw / 2 - 0.5 * s, bh2);
    c.fillStyle = held.RMB ? 'rgba(240,160,32,0.95)' : 'rgba(255,255,255,0.05)';
    c.fillRect(mx + mw / 2 + 0.5 * s, my, mw / 2 - 0.5 * s, bh2);
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = Math.max(1, 1.5 * s);
    c.beginPath();
    c.moveTo(mx + mw / 2, my); c.lineTo(mx + mw / 2, my + bh2);
    c.moveTo(mx, my + bh2); c.lineTo(mx + mw, my + bh2);
    c.stroke();
    // wheel
    const ww = 0.34 * mw, wh = 0.72 * u;
    const wheel = held.WHEEL;
    this._panel(mx + mw / 2 - ww / 2, my + 0.25 * u, ww, wh, ww / 2, wheel ? '#ffd34d' : kn('WHEEL') ? '#2a2f38' : '#1c2027',
      'rgba(255,255,255,0.25)');
    if (wheel) this._text('▼', mx + mw / 2, my + 0.25 * u + wh / 2, 9 * s, '#141414', 'center', 800);
    // movement: a dot pushed in the direction the mouse moves
    const cx = mx + mw / 2, cy = my + bh2 + (bh - bh2) / 2, r = Math.min(mw, bh - bh2) * 0.34;
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = Math.max(1, s);
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    const [dx, dy] = k.mouse;
    const mag = Math.hypot(dx, dy);
    if (mag > 4) {
      const len = r * Math.min(1, Math.log1p(mag / 25) / Math.log1p(40)); // 1000 deg/s fills the circle
      const ex2 = cx + (dx / mag) * len, ey2 = cy + (dy / mag) * len;
      c.strokeStyle = '#ffd34d';
      c.lineWidth = 2.5 * s;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(ex2, ey2); c.stroke();
      c.fillStyle = '#ffd34d';
      c.beginPath(); c.arc(ex2, ey2, 3 * s, 0, Math.PI * 2); c.fill();
    } else {
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.beginPath(); c.arc(cx, cy, 2 * s, 0, Math.PI * 2); c.fill();
    }
    if (!info.pov) {
      this._text(k.name, x0, y0 - 9 * s, 12 * s, '#e7e9ee', 'left', 600);
    }
  }

  _crosshair(W, H, s) {
    const c = this.ctx;
    const cx = W / 2, cy = H / 2, g = 4 * s, l = 7 * s;
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 4 * s;
    this._cross(cx, cy, g, l);
    c.strokeStyle = '#4dff7c';
    c.lineWidth = 2 * s;
    this._cross(cx, cy, g, l);
  }

  _cross(cx, cy, g, l) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(cx - g - l, cy); c.lineTo(cx - g, cy);
    c.moveTo(cx + g, cy); c.lineTo(cx + g + l, cy);
    c.moveTo(cx, cy - g - l); c.lineTo(cx, cy - g);
    c.moveTo(cx, cy + g); c.lineTo(cx, cy + g + l);
    c.stroke();
  }

  _scope(W, H, s) {
    const c = this.ctx;
    const r = H * 0.47;
    c.save();
    c.fillStyle = '#000';
    c.beginPath();
    c.rect(0, 0, W, H);
    c.arc(W / 2, H / 2, r, 0, Math.PI * 2, true);
    c.fill('evenodd');
    c.strokeStyle = '#000';
    c.lineWidth = 1.5 * s;
    c.beginPath();
    c.moveTo(W / 2 - r, H / 2); c.lineTo(W / 2 + r, H / 2);
    c.moveTo(W / 2, H / 2 - r); c.lineTo(W / 2, H / 2 + r);
    c.stroke();
    c.restore();
  }

  _clipCard(info, W, H, s) {
    const { clip, tick, demo } = info;
    const rate = demo.tickRate;
    const age = (tick - clip.start) / rate;
    const c = this.ctx;
    // watermark
    c.globalAlpha = 0.75;
    this._text(`${clip.match || demo.meta.map} · раунд ${clip.round} · ${clip.playerName}`, 14 * s, 18 * s, 12 * s, '#d5d9e0', 'left', 500);
    c.globalAlpha = 1;
    if (age < 0 || age > 3.5) return;
    const alpha = Math.min(1, age / 0.3, (3.5 - age) / 0.5);
    c.globalAlpha = Math.max(0, alpha);
    // above the on-screen keyboard when it is shown
    const y = Math.min(H * 0.74, this._kbTop === null ? Infinity : this._kbTop - 80 * s);
    c.font = `800 ${30 * s}px ${FONT}`;
    const title = (clip.badge ? `${clip.badge}  ` : '') + (clip.label ? `${clip.label} — ${clip.playerName}` : clip.title);
    const tw = c.measureText(title).width;
    const tags = (clip.tags || []).slice(0, 5).join('  ·  ');
    c.font = `500 ${14 * s}px ${FONT}`;
    const gw = c.measureText(tags).width;
    const w = Math.max(tw, gw) + 48 * s;
    const x = 30 * s;
    this._panel(x, y, w, 70 * s, 8 * s, 'rgba(10,12,15,0.8)');
    c.fillStyle = COLORS[clip.side || 'T'];
    c.fillRect(x, y, 6 * s, 70 * s);
    this._text(title, x + 22 * s, y + 25 * s, 30 * s, '#ffffff', 'left', 800);
    this._text(tags, x + 22 * s, y + 52 * s, 14 * s, '#ffd34d', 'left', 500);
    c.globalAlpha = 1;
  }
}
