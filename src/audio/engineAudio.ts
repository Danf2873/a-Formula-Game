import type { Telemetry } from '../types';

/** Synthesised V6 hybrid engine + tyre/surface/wind sounds. Safe no-op without WebAudio. */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private volume = 0.7;
  private muted = false;
  private failed = false;

  private master!: GainNode;
  private oscs: OscillatorNode[] = [];
  private oscRatios = [1, 1.006, 0.5];
  private engineGain!: GainNode;
  private lowpass!: BiquadFilterNode;
  private turbo!: OscillatorNode;
  private turboGain!: GainNode;
  private squealGain!: GainNode;
  private rumbleGain!: GainNode;
  private windGain!: GainNode;

  constructor() { /* AudioContext created lazily in resume() */ }

  /** Call from a user gesture. Creates the context on first call. */
  resume(): void {
    if (this.failed) return;
    try {
      if (!this.ctx) this.build();
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.failed = true;
      this.ctx = null;
    }
  }

  private noise(ctx: AudioContext): AudioBufferSourceNode {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  private build(): void {
    const AC: typeof AudioContext | undefined =
      typeof window !== 'undefined' ? (window.AudioContext ?? (window as any).webkitAudioContext) : undefined;
    if (!AC) { this.failed = true; return; }
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    // Engine: oscillators -> lowpass -> distortion -> gain
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 800;
    this.lowpass.Q.value = 2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 3);
    }
    shaper.curve = curve;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0;
    const mix = ctx.createGain();
    mix.gain.value = 0.25;
    const types: OscillatorType[] = ['sawtooth', 'sawtooth', 'square'];
    this.oscs = types.map((type) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 100;
      o.connect(mix);
      o.start();
      return o;
    });
    mix.connect(this.lowpass);
    this.lowpass.connect(shaper);
    shaper.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Turbo / MGU whine
    this.turbo = ctx.createOscillator();
    this.turbo.type = 'sine';
    this.turbo.frequency.value = 2000;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain);
    this.turboGain.connect(this.master);
    this.turbo.start();

    // Tyre squeal
    const sq = this.noise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 8;
    this.squealGain = ctx.createGain(); this.squealGain.gain.value = 0;
    sq.connect(bp); bp.connect(this.squealGain); this.squealGain.connect(this.master);
    sq.start();

    // Surface rumble
    const rb = this.noise(ctx);
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass'; rlp.frequency.value = 220;
    this.rumbleGain = ctx.createGain(); this.rumbleGain.gain.value = 0;
    rb.connect(rlp); rlp.connect(this.rumbleGain); this.rumbleGain.connect(this.master);
    rb.start();

    // Wind
    const wn = this.noise(ctx);
    const wlp = ctx.createBiquadFilter();
    wlp.type = 'lowpass'; wlp.frequency.value = 900;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    wn.connect(wlp); wlp.connect(this.windGain); this.windGain.connect(this.master);
    wn.start();
  }

  update(t: Telemetry): void {
    const ctx = this.ctx;
    if (!ctx || this.failed) return;
    const now = ctx.currentTime;
    const sm = 0.04;
    const rpm = Math.max(3500, t.rpm || 0);
    const fund = rpm / 20; // V6 four-stroke: 3 firings per revolution
    for (let i = 0; i < this.oscs.length; i++) {
      this.oscs[i].frequency.setTargetAtTime(fund * this.oscRatios[i], now, sm);
    }
    const thr = Math.max(0, Math.min(1, t.throttle));
    this.lowpass.frequency.setTargetAtTime(500 + 3500 * thr + rpm * 0.15, now, 0.06);
    this.engineGain.gain.setTargetAtTime(0.25 + 0.55 * thr, now, 0.06);

    this.turbo.frequency.setTargetAtTime(1500 + rpm * 0.35, now, sm);
    this.turboGain.gain.setTargetAtTime(0.01 + 0.02 * thr * (rpm / 12000), now, 0.1);

    const slips = t.wheelSlip ?? [];
    const skid = slips.length ? Math.max(...slips) : 0;
    const sqv = t.speedKmh > 15 ? Math.max(0, Math.min(1, (skid - 0.9) * 1.2)) : 0;
    this.squealGain.gain.setTargetAtTime(sqv * 0.25, now, 0.05);

    let rough = 0;
    for (const s of t.surface ?? []) {
      if (s === 'grass' || s === 'gravel') rough += 0.25;
      else if (s === 'kerb') rough += 0.08;
    }
    const spd = Math.min(1, t.speedKmh / 150);
    this.rumbleGain.gain.setTargetAtTime(Math.min(1, rough) * spd * 0.5, now, 0.08);

    const w = Math.min(1, (t.speedKmh / 330) ** 2);
    this.windGain.gain.setTargetAtTime(w * 0.18, now, 0.1);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  mute(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }
}
