// Player POV: one player's first-person view over whole rounds. While they
// live the round plays at normal speed; after their death (and a short death
// cam) the rest of the round runs fast-forward, watching a living teammate
// like the in-game spectator; freeze time is skipped. Used live (viewer
// option) and for recordings (PovDirector: one video over chosen rounds).
import { ClipDirector } from './clips.js';
import { renderClipAudio } from './audio.js';

export const POV_FF_SPEEDS = [4, 8, 16];
export const DEATH_HOLD = 2.0; // s of death cam at normal speed
const PRE = 2.0; // s before the end of freeze time
const POST = 2.0; // s after the round is decided
const RAMP = 0.5; // s (game time) to speed up / slow down

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Death of ``player`` in round ``r`` (null if they survived). */
export function deathIn(demo, player, r) {
  for (const k of demo.kills) {
    if (k.tick > r.next) break;
    if (k.victim === player && k.tick >= r.start) return k;
  }
  return null;
}

/**
 * Whom to watch once ``player`` is dead: the teammate watched so far while
 * alive, else the living teammate nearest to where ``player`` died, else the
 * nearest living player. -1 if nobody is alive.
 */
export function spectateTarget(demo, player, tick, prev, scratch) {
  const me = demo.state(player, tick, scratch.me);
  if (prev >= 0 && prev !== player) {
    const st = demo.state(prev, tick, scratch.st);
    if (st.present && st.alive && st.side === me.side) return prev;
  }
  let best = -1, bestD = Infinity, bestTeam = false;
  for (let p = 0; p < demo.P; p++) {
    if (p === player) continue;
    const st = demo.state(p, tick, scratch.st);
    if (!st.present || !st.alive) continue;
    const team = st.side === me.side;
    const dist = Math.hypot(st.x - me.x, st.y - me.y, st.z - me.z);
    if ((team && !bestTeam) || (team === bestTeam && dist < bestD)) {
      best = p; bestD = dist; bestTeam = team;
    }
  }
  return best;
}

/** Speed of the POV playback at ``tick`` of round ``r`` given the death (ff: speed-up). */
export function povSpeed(r, death, tick, rate, ff) {
  if (!death || ff <= 1) return 1;
  const from = death.tick + DEATH_HOLD * rate;
  const up = smooth((tick - from) / (RAMP * rate));
  const down = smooth((r.end - tick) / (RAMP * rate));
  return 1 + (ff - 1) * up * down;
}

/**
 * Frames of a POV recording: [{tick, focus, ff}] at ``fps``, and ``parts``:
 * [[firstFrame, endFrame, round]] one per round. ``ff`` = 0 cuts the round
 * after the death cam instead of fast-forwarding.
 */
export function povPlan(demo, player, roundIdxs, { fps = 30, ff = 8 } = {}) {
  const rate = demo.tickRate;
  const frames = [];
  const parts = [];
  const scratch = { me: demo.state(player, demo.startTick), st: demo.state(player, demo.startTick) };
  for (const ri of roundIdxs) {
    const r = demo.rounds[ri];
    if (!r) continue;
    const st = demo.state(player, r.freezeEnd, scratch.st);
    if (!st.present) continue;
    const death = deathIn(demo, player, r);
    let t = Math.max(r.start, r.freezeEnd - PRE * rate);
    let end = Math.min(r.end + POST * rate, r.next ?? demo.endTick, demo.endTick);
    if (death && ff === 0) end = Math.min(end, death.tick + DEATH_HOLD * rate);
    const first = frames.length;
    let watch = -1;
    const hold = death ? death.tick + DEATH_HOLD * rate : Infinity;
    while (t <= end && frames.length - first < 30 * 60 * fps) {
      const speed = povSpeed(r, death, t, rate, ff);
      let focus = player;
      if (t >= hold && t < r.end) {
        watch = spectateTarget(demo, player, t, watch, scratch);
        if (watch >= 0) focus = watch;
      }
      frames.push({ tick: t, focus, ff: speed });
      t += (rate / fps) * speed;
    }
    if (frames.length > first) parts.push([first, frames.length, r.num]);
  }
  return { frames, parts };
}

/** Records a player's POV over rounds into one video (see clips.js for export). */
export class PovDirector extends ClipDirector {
  constructor(viewer, player, roundIdxs, opts = {}) {
    const demo = viewer.demo;
    const name = demo.players[player]?.name || `player${player}`;
    const plan = povPlan(demo, player, roundIdxs, { fps: opts.fps || 30, ff: opts.ff ?? 8 });
    if (!plan.frames.length) throw new Error('Игрок не играл в выбранных раундах');
    const nums = plan.parts.map((p) => p[2]);
    const label = nums.length > 1 ? `${nums[0]}-${nums[nums.length - 1]}` : `${nums[0]}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '').slice(0, 24) || `p${player}`;
    const h = {
      id: `pov-${slug}-r${label}`, player, playerName: name, title: `POV ${name} · раунды ${label}`,
      round: nums[0], score: 0, tags: ['POV'], start: plan.frames[0].tick,
      end: plan.frames[plan.frames.length - 1].tick, killTicks: [],
    };
    super(viewer, h, { ...opts, pov: 'first', slowmo: false }, plan.frames.map((f) => f.tick));
    this.plan = plan;
    this.rounds = nums;
  }

  get fileName() { return this.h.id; }

  start() {
    super.start();
    const v = this.viewer;
    this.saved.banner = v.banner;
    v.clip = null;
    this._focus = this.h.player;
  }

  render(i) {
    if (!this.started) this.start();
    const f = this.plan.frames[Math.min(i, this.plan.frames.length - 1)];
    const v = this.viewer;
    if (f.focus !== this._focus) {
      this._focus = f.focus;
      v.setMode('pov', f.focus);
    }
    v.banner = povBanner(v.demo, this.h.player, f.focus, f.ff);
    return super.render(i);
  }

  finish() {
    if (!this.started) return;
    this.viewer.banner = this.saved.banner;
    super.finish();
  }

  /** One audio part per round, so long videos never hold all their sound at once. */
  get audioParts() { return this.plan.parts.map(([a, b]) => [a, b]); }

  async audioRange(a, b) {
    if (!this.opts.sound || typeof OfflineAudioContext === 'undefined') return null;
    return renderClipAudio(this.viewer.demo, this.ticks.slice(a, b), this.opts.fps, this.h.player, {
      voice: this.voiceMode,
    });
  }

  get info() {
    return { ...super.info, pov: 'pov', rounds: this.rounds, ff: this.opts.ff ?? 8, title: this.h.title };
  }
}

/** HUD line for POV playback: whose POV, whom we watch, how fast. */
export function povBanner(demo, player, focus, ff) {
  const name = demo.players[player]?.name || '';
  let text = `POV ${name}`;
  if (focus !== player) text += ` · мёртв, смотрим ${demo.players[focus]?.name || ''}`;
  return { text, ff: ff > 1.05 ? ff : 0 };
}

/** Headless renderer (cs2demo/recorder.py): POV by player name and round numbers. */
export function installPovRenderApi(api) {
  api.beginPov = (name, roundNums, opts = {}) => {
    const demo = api.getDemo();
    const want = String(name).toLowerCase();
    let p = demo.players.findIndex((x) => x.name.toLowerCase() === want);
    if (p < 0) p = demo.players.findIndex((x) => x.name.toLowerCase().includes(want));
    if (p < 0) throw new Error(`нет игрока ${name}`);
    const idx = demo.rounds.map((r, i) => [r.num, i])
      .filter(([num]) => !roundNums || !roundNums.length || roundNums.includes(num)).map(([, i]) => i);
    const director = new PovDirector(api.viewer, p, idx, {
      ...opts, width: window.innerWidth, height: window.innerHeight,
    });
    return { ...api.use(director), file: director.fileName, info: director.info };
  };
}
