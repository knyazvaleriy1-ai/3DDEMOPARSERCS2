// Timeline bar: rounds, kills, highlights and the playhead; click/drag to seek.
import { COLORS } from './util.js';

export class Timeline {
  constructor(canvas, viewer) {
    this.canvas = canvas;
    this.viewer = viewer;
    this.ctx = canvas.getContext('2d');
    this.hover = null;
    this.activeHighlight = null;
    const seek = (e) => {
      const d = this.viewer.demo;
      if (!d) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.min(Math.max(0, e.clientX - r.left), r.width);
      this.viewer.setTick(d.startTick + (x / r.width) * (d.endTick - d.startTick));
    };
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); seek(e); });
    canvas.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  draw() {
    const d = this.viewer.demo;
    const c = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const H = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#1c2027';
    c.fillRect(0, 0, W, H);
    if (!d) return;
    const span = d.endTick - d.startTick || 1;
    const X = (t) => ((t - d.startTick) / span) * W;

    // Rounds
    d.rounds.forEach((r, i) => {
      const x0 = X(r.start), x1 = X(r.next ?? r.end);
      c.fillStyle = i % 2 ? '#20252d' : '#252b34';
      c.fillRect(x0, 0, Math.max(1, x1 - x0), H);
      if (r.winner) {
        c.fillStyle = COLORS[r.winner];
        c.globalAlpha = 0.65;
        c.fillRect(x0, H - 4 * dpr, Math.max(1, x1 - x0), 4 * dpr);
        c.globalAlpha = 1;
      }
      if (x1 - x0 > 18 * dpr) {
        c.fillStyle = '#8b93a1';
        c.font = `${10 * dpr}px system-ui, sans-serif`;
        c.textBaseline = 'top';
        c.fillText(r.knife ? 'нож' : String(r.num), x0 + 3 * dpr, 3 * dpr);
      }
    });

    // Highlights
    for (const h of d.highlights) {
      const x0 = X(h.start), x1 = X(h.end);
      c.fillStyle = h === this.activeHighlight ? 'rgba(255,211,77,0.55)' : 'rgba(240,160,32,0.22)';
      c.fillRect(x0, 16 * dpr, Math.max(2, x1 - x0), H - 24 * dpr);
    }

    // Kills
    for (const k of d.kills) {
      const x = X(k.tick);
      c.fillStyle = COLORS[k.attackerSide || 'T'] || '#ccc';
      c.fillRect(x - dpr * 0.75, 18 * dpr, 1.5 * dpr, H - 26 * dpr);
    }

    // Playhead
    const px = X(this.viewer.tick);
    c.fillStyle = '#ffffff';
    c.fillRect(px - dpr, 0, 2 * dpr, H);
    c.beginPath();
    c.moveTo(px - 5 * dpr, 0);
    c.lineTo(px + 5 * dpr, 0);
    c.lineTo(px, 6 * dpr);
    c.fill();
  }
}
