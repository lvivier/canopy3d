/**
 * Procedural Web Audio Engine for Canopy 3D.
 * Synthesizes coastal forest wind ambience, distant birds, pole saw zips,
 * chainsaw idle/rev/wood-bite, wedge hammer hits, wood creaking/snapping,
 * timber impact thud, and pleasant UI/success chimes.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private sawOsc: OscillatorNode | null = null;
  private sawSubOsc: OscillatorNode | null = null;
  private sawGain: GainNode | null = null;
  private sawFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private birdTimer: number | null = null;
  private muted = false;
  private initialized = false;
  private activeSawMode: 'none' | 'prune' | 'chainsaw' = 'none';

  public init(): void {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.65;
      this.masterGain.connect(this.ctx.destination);

      // Shared white/pink noise buffer (3 seconds)
      const sr = this.ctx.sampleRate;
      const len = sr * 3;
      this.noiseBuffer = this.ctx.createBuffer(1, len, sr);
      const data = this.noiseBuffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + white * 0.029;
        b1 = 0.985 * b1 + white * 0.032;
        b2 = 0.950 * b2 + white * 0.048;
        data[i] = (b0 + b1 + b2 + white * 0.12) * 0.85;
      }

      this.setupWindAmbience();
      this.setupSawSynth();
      this.startBirdAmbience();
      this.initialized = true;
    } catch {
      // AudioContext unavailable
    }
  }

  private setupWindAmbience(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 340;
    this.windFilter.Q.value = 1.4;

    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.07;

    src.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.masterGain);
    src.start();
  }

  private setupSawSynth(): void {
    if (!this.ctx || !this.masterGain) return;
    this.sawOsc = this.ctx.createOscillator();
    this.sawOsc.type = 'sawtooth';
    this.sawOsc.frequency.value = 65;

    this.sawSubOsc = this.ctx.createOscillator();
    this.sawSubOsc.type = 'square';
    this.sawSubOsc.frequency.value = 32.5;

    this.sawFilter = this.ctx.createBiquadFilter();
    this.sawFilter.type = 'lowpass';
    this.sawFilter.frequency.value = 450;
    this.sawFilter.Q.value = 2.5;

    this.sawGain = this.ctx.createGain();
    this.sawGain.gain.value = 0.0001;

    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.45;

    this.sawOsc.connect(this.sawFilter);
    this.sawSubOsc.connect(subGain);
    subGain.connect(this.sawFilter);
    this.sawFilter.connect(this.sawGain);
    this.sawGain.connect(this.masterGain);

    this.sawOsc.start();
    this.sawSubOsc.start();
  }

  private startBirdAmbience(): void {
    const schedule = () => {
      const delay = 5500 + Math.random() * 11000;
      this.birdTimer = window.setTimeout(() => {
        if (!this.muted && this.ctx && this.ctx.state === 'running') {
          this.playDistantBird();
        }
        schedule();
      }, delay);
    };
    schedule();
  }

  private playDistantBird(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const baseFreq = 2100 + Math.random() * 1400;
    const chirps = Math.random() > 0.4 ? 2 : 3;

    for (let i = 0; i < chirps; i++) {
      const t = now + i * 0.16;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * (1.18 + Math.random() * 0.12), t + 0.07);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.92, t + 0.13);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.018, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.15);
    }
  }

  public setWindLevel(windSpeed: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const now = this.ctx.currentTime;
    const clamped = Math.max(0.05, Math.min(1, windSpeed));
    this.windGain.gain.setTargetAtTime(0.05 + clamped * 0.16, now, 0.4);
    this.windFilter.frequency.setTargetAtTime(260 + clamped * 480, now, 0.4);
  }

  public setSawActive(mode: 'none' | 'prune' | 'chainsaw', intensity = 1): void {
    if (!this.ctx || !this.sawGain || !this.sawOsc || !this.sawSubOsc || !this.sawFilter) return;
    const now = this.ctx.currentTime;
    this.activeSawMode = mode;

    if (mode === 'none') {
      this.sawGain.gain.setTargetAtTime(0.0001, now, 0.05);
      return;
    }

    if (mode === 'prune') {
      // Crisp rhythmic electric/pole pruner hum
      const freq = 145 + intensity * 70 + Math.sin(now * 28) * 14;
      this.sawOsc.frequency.setTargetAtTime(freq, now, 0.03);
      this.sawSubOsc.frequency.setTargetAtTime(freq * 0.5, now, 0.03);
      this.sawFilter.frequency.setTargetAtTime(1100, now, 0.05);
      this.sawGain.gain.setTargetAtTime(0.085, now, 0.04);
    } else {
      // Gritty 2-stroke chainsaw revving under load
      const flutter = Math.sin(now * 44) * 8;
      const freq = 78 + intensity * 56 + flutter;
      this.sawOsc.frequency.setTargetAtTime(freq, now, 0.03);
      this.sawSubOsc.frequency.setTargetAtTime(freq * 0.5, now, 0.03);
      this.sawFilter.frequency.setTargetAtTime(680 + intensity * 620, now, 0.05);
      this.sawGain.gain.setTargetAtTime(0.14, now, 0.04);
    }
  }

  public playBranchSnap(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1350, now);
    filter.frequency.exponentialRampToValueAtTime(320, now + 0.16);
    filter.Q.value = 1.8;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(now);
    src.stop(now + 0.2);
  }

  public playWedgeStrike(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // Metallic axe-head ping + wooden thunk
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(210, now);
    osc.frequency.exponentialRampToValueAtTime(68, now + 0.14);

    const ping = this.ctx.createOscillator();
    ping.type = 'sine';
    ping.frequency.setValueAtTime(1650, now);
    ping.frequency.exponentialRampToValueAtTime(1120, now + 0.09);

    const g1 = this.ctx.createGain();
    g1.gain.setValueAtTime(0.32, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.11, now);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

    osc.connect(g1);
    ping.connect(g2);
    g1.connect(this.masterGain);
    g2.connect(this.masterGain);

    osc.start(now);
    ping.start(now);
    osc.stop(now + 0.17);
    ping.stop(now + 0.11);
  }

  public playTimberCreak(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    // Dramatic wood fibers splitting & groaning
    for (let i = 0; i < 4; i++) {
      const t = now + i * 0.19 + Math.random() * 0.05;
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      const f0 = 130 + Math.random() * 75;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.linearRampToValueAtTime(f0 * 0.65, t + 0.18);

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 540;
      filter.Q.value = 4.0;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.24);
    }
  }

  public playTimberCrash(weightScale = 1): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // Deep earth-shaking bass thump
    const bass = this.ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.setValueAtTime(92, now);
    bass.frequency.exponentialRampToValueAtTime(24, now + 0.65);

    const bassGain = this.ctx.createGain();
    bassGain.gain.setValueAtTime(Math.min(0.6, 0.42 * weightScale), now);
    bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.72);

    bass.connect(bassGain);
    bassGain.connect(this.masterGain);
    bass.start(now);
    bass.stop(now + 0.75);

    // Crashing boughs & rustling foliage burst
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1600, now);
    filter.frequency.exponentialRampToValueAtTime(220, now + 1.15);

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.36 * Math.min(1.3, weightScale), now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 1.25);

    src.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.masterGain);
    src.start(now);
    src.stop(now + 1.3);
  }

  public playSuccessChime(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const t = now + idx * 0.085;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.11, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.42);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.45);
    });
  }

  public playWarningBuzz(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(155, now);
    osc.frequency.linearRampToValueAtTime(120, now + 0.24);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  public playClick(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(640, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.045);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.055);
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.65, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public getSawMode(): string {
    return this.activeSawMode;
  }

  public dispose(): void {
    if (this.birdTimer !== null) clearTimeout(this.birdTimer);
    if (this.ctx) {
      this.ctx.close().catch(() => {});
    }
  }
}
