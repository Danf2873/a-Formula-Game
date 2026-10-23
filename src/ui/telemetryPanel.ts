import type { Telemetry } from '../types';
import { el } from './dom';

const WINDOW_S = 20;
const SAMPLE_HZ = 30;
const N = WINDOW_S * SAMPLE_HZ;

interface Sample {
  speed: number; thr: number; brk: number; steer: number; latG: number; longG: number; temps: [number, number, number, number];
}

export class TelemetryPanel {
  private wrap: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private buf: Sample[] = [];
  private lastSample = 0;
  private lastDraw = 0;
  private open = false;
  private dist = 0;

  constructor(root: HTMLElement) {
    this.wrap = el('div', 'telemetry panel hidden', undefined, root);
    el('div', 'tel-title', 'TELEMETRY (T)', this.wrap);
    this.canvas = el('canvas', 'tel-canvas', undefined, this.wrap);
    this.canvas.width = 480; this.canvas.height = 520;
    this.ctx = this.canvas.getContext('2d');
  }

  toggle(): void {
    this.open = !this.open;
    this.wrap.classList.toggle('hidden', !this.open);
  }

  push(t: Telemetry, s: number): void {
    const now = performance.now();
    this.dist = s;
    if (now - this.lastSample >= 1000 / SAMPLE_HZ) {
      this.lastSample = now;
      const tt = t.tyres;
      this.buf.push({
        speed: t.speedKmh, thr: t.throttle, brk: t.brake, steer: t.steer, latG: t.latG, longG: t.longG,
        temps: [tt[0]?.tempC ?? 0, tt[1]?.tempC ?? 0, tt[2]?.tempC ?? 0, tt[3]?.tempC ?? 0],
      });
      if (this.buf.length > N) this.buf.shift();
    }
    if (this.open && now - this.lastDraw > 66) {
      this.lastDraw = now;
      this.draw();
    }
  }

  private graph(
    x: number, y: number, w: number, h: number, label: string, min: number, max: number,
    series: { color: string; get: (s: Sample) => number; fill?: boolean }[],
  ): void {
    const c = this.ctx!;
    c.fillStyle = 'rgba(255,255,255,0.04)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (min < 0 && max > 0) {
      const zy = y + h - ((0 - min) / (max - min)) * h;
      c.beginPath(); c.moveTo(x, zy); c.lineTo(x + w, zy); c.stroke();
    }
    for (const se of series) {
      c.beginPath();
      const n = this.buf.length;
      for (let i = 0; i < n; i++) {
        const px = x + ((N - n + i) / (N - 1)) * w;
        const v = Math.max(min, Math.min(max, se.get(this.buf[i])));
        const py = y + h - ((v - min) / (max - min)) * h;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.strokeStyle = se.color; c.lineWidth = 1.5; c.stroke();
      if (se.fill && n > 1) {
        c.lineTo(x + w, y + h); c.lineTo(x + ((N - n) / (N - 1)) * w, y + h); c.closePath();
        c.globalAlpha = 0.18; c.fillStyle = se.color; c.fill(); c.globalAlpha = 1;
      }
    }
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.font = '11px "Titillium Web", sans-serif';
    c.fillText(label, x + 6, y + 13);
    const last = this.buf[this.buf.length - 1];
    if (last && series[0]) {
      c.textAlign = 'right';
      c.fillText(series[0].get(last).toFixed(Math.abs(max) <= 5 ? 2 : 0), x + w - 6, y + 13);
      c.textAlign = 'left';
    }
  }

  private draw(): void {
    const c = this.ctx;
    if (!c) return;
    const W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    const gap = 8, pad = 4;
    const gw = W - pad * 2;
    const hs = (H - pad * 2 - gap * 4) / 5;
    let y = pad;
    this.graph(pad, y, gw, hs, 'SPEED km/h', 0, 380, [{ color: '#e10600', get: s => s.speed, fill: true }]); y += hs + gap;
    this.graph(pad, y, gw, hs, 'THROTTLE / BRAKE', 0, 1, [
      { color: '#43b02a', get: s => s.thr, fill: true }, { color: '#e10600', get: s => s.brk, fill: true },
    ]); y += hs + gap;
    this.graph(pad, y, gw, hs, 'STEER', -1, 1, [{ color: '#47c7fc', get: s => s.steer }]); y += hs + gap;
    this.graph(pad, y, gw, hs, 'LAT G / LONG G', -6, 6, [
      { color: '#ffd400', get: s => s.latG }, { color: '#ff8000', get: s => s.longG },
    ]); y += hs + gap;
    this.graph(pad, y, gw, hs, 'TYRE TEMP FL FR RL RR', 20, 150, [
      { color: '#47c7fc', get: s => s.temps[0] }, { color: '#43b02a', get: s => s.temps[1] },
      { color: '#ffd400', get: s => s.temps[2] }, { color: '#e10600', get: s => s.temps[3] },
    ]);
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.font = '11px "Titillium Web", sans-serif';
    c.fillText(`s = ${Math.round(this.dist)} m`, W - 80, H - 2);
  }
}
