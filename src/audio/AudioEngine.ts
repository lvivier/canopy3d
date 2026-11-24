/**
 * Procedural Web Audio Engine for Canopy 3D.
 * Synthesizes forest wind ambience, distant birds, pleasant electric pruning/bucking
 * saws, a realistic two-stroke chainsaw (lopey carbureted idle, throttle blip,
 * brawny wood-loaded roar, bar/chain rasp, and coast-down), wedge hammer hits,
 * wood creaking/snapping, timber impact thud, and pleasant UI/success chimes.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  // Pleasant electric saw synth (Prune Saw & Limb/Buck)
  private sawOsc: OscillatorNode | null = null;
  private sawSubOsc: OscillatorNode | null = null;
  private sawGain: GainNode | null = null;
  private sawFilter: BiquadFilterNode | null = null;

  // Dedicated realistic 2-stroke Chainsaw synth graph
  private csEngineOsc: OscillatorNode | null = null;
  private csSubOsc: OscillatorNode | null = null;
  private csPipeOsc: OscillatorNode | null = null;
  private csSubGain: GainNode | null = null;
  private csPipeGain: GainNode | null = null;
  private csDriveGain: GainNode | null = null;
  private csMufflerLow: BiquadFilterNode | null = null;
  private csMufflerMid: BiquadFilterNode | null = null;
  private csMufflerHigh: BiquadFilterNode | null = null;
  private csExhaustNoiseGain: GainNode | null = null;
  private csExhaustNoiseFilter: BiquadFilterNode | null = null;
  private csChainBiteGain: GainNode | null = null;
  private csChainBiteFilter: BiquadFilterNode | null = null;
  private csBusGain: GainNode | null = null;

  // 2-stroke physics state
  private csSelected = false;
  private csCutting = false;
  private csCutIntensity = 1.0;
  private csWoodDensity = 1.0;
  private csRpm = 0; // actual RPM (0 = off, ~2750 = idle, ~8800-10800 = cutting roar)
  private csTargetRpm = 0;
  private csBlipTimer = 0;
  private csLopePhase = 0;
  private csClock = 0;
  private csPrevCutting = false;

  private noiseBuffer: AudioBuffer | null = null;
  private birdTimer: number | null = null;
  private muted = false;
  private initialized = false;
  private activeSawMode: 'none' | 'prune' | 'electric_buck' | 'chainsaw' = 'none';

  public init(): void {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
      let b0 = 0,
        b1 = 0,
        b2 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + white * 0.029;
        b1 = 0.985 * b1 + white * 0.032;
        b2 = 0.95 * b2 + white * 0.048;
        data[i] = (b0 + b1 + b2 + white * 0.12) * 0.85;
      }

      this.setupWindAmbience();
      this.setupSawSynth();
      this.setupTwoStrokeChainsaw();
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

  private setupTwoStrokeChainsaw(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;

    // 1. Custom asymmetric combustion-pulse PeriodicWave (sharp exhaust pressure spike + warm rolloff)
    const harmonics = 28;
    const real = new Float32Array(harmonics);
    const imag = new Float32Array(harmonics);
    for (let k = 1; k < harmonics; k++) {
      // Narrower impulse = rich mid-range bark; slight even/odd tilt mimics exhaust port opening
      const decay = 1 / Math.pow(k, 0.72);
      const tilt = k % 2 === 1 ? 1.0 : 0.78;
      real[k] = decay * tilt * Math.cos(k * 0.35);
      imag[k] = decay * tilt * Math.sin(k * 0.35);
    }
    const pulseWave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });

    // Primary cylinder firing pulse (~46 Hz at 2750 RPM -> ~160 Hz at 9600 RPM)
    this.csEngineOsc = this.ctx.createOscillator();
    this.csEngineOsc.setPeriodicWave(pulseWave);
    this.csEngineOsc.frequency.value = 46;

    // Sub-harmonic "4-stroking" crankcase lope (half firing rate: makes idle sputter authentically)
    this.csSubOsc = this.ctx.createOscillator();
    this.csSubOsc.type = 'sawtooth';
    this.csSubOsc.frequency.value = 23;

    this.csSubGain = this.ctx.createGain();
    this.csSubGain.gain.value = 0.52;

    // 2-stroke expansion-chamber / muffler 2nd harmonic scream when revved onto the pipe
    this.csPipeOsc = this.ctx.createOscillator();
    this.csPipeOsc.type = 'sawtooth';
    this.csPipeOsc.frequency.value = 92;

    this.csPipeGain = this.ctx.createGain();
    this.csPipeGain.gain.value = 0.08;

    // Pre-shaper drive node (more drive under load = brawny, saturated exhaust roar)
    this.csDriveGain = this.ctx.createGain();
    this.csDriveGain.gain.value = 1.2;

    // Asymmetric exhaust waveshaper for gritty mechanical 2-stroke bark
    const shaper = this.ctx.createWaveShaper();
    const curveLen = 1024;
    const curve = new Float32Array(curveLen);
    for (let i = 0; i < curveLen; i++) {
      const x = (i * 2) / curveLen - 1;
      // Asymmetric soft-hard clip: gives warm even + aggressive odd exhaust harmonics
      curve[i] = x >= 0 ? Math.tanh(x * 3.4) : Math.tanh(x * 2.1) * 0.92;
    }
    shaper.curve = curve;
    shaper.oversample = '2x';

    // Tin-can chainsaw muffler resonant filter chain
    // Crankcase punch (~140 Hz)
    this.csMufflerLow = this.ctx.createBiquadFilter();
    this.csMufflerLow.type = 'peaking';
    this.csMufflerLow.frequency.value = 145;
    this.csMufflerLow.Q.value = 1.4;
    this.csMufflerLow.gain.value = 5.5;

    // Signature hollow metal muffler box resonance (~580-860 Hz)
    this.csMufflerMid = this.ctx.createBiquadFilter();
    this.csMufflerMid.type = 'peaking';
    this.csMufflerMid.frequency.value = 620;
    this.csMufflerMid.Q.value = 2.2;
    this.csMufflerMid.gain.value = 7.0;

    // Upper exhaust ceiling (keeps idle mellow/warm, opens wide to bite when cutting)
    this.csMufflerHigh = this.ctx.createBiquadFilter();
    this.csMufflerHigh.type = 'lowpass';
    this.csMufflerHigh.frequency.value = 1400;
    this.csMufflerHigh.Q.value = 1.2;

    // Exhaust air-puff & carburetor intake roar noise
    const exhaustNoiseSrc = this.ctx.createBufferSource();
    exhaustNoiseSrc.buffer = this.noiseBuffer;
    exhaustNoiseSrc.loop = true;

    this.csExhaustNoiseFilter = this.ctx.createBiquadFilter();
    this.csExhaustNoiseFilter.type = 'bandpass';
    this.csExhaustNoiseFilter.frequency.value = 460;
    this.csExhaustNoiseFilter.Q.value = 1.3;

    this.csExhaustNoiseGain = this.ctx.createGain();
    this.csExhaustNoiseGain.gain.value = 0.08;

    // Bar-and-chain wood-bite & chip-tearing rasp (surges during cutting!)
    const biteNoiseSrc = this.ctx.createBufferSource();
    biteNoiseSrc.buffer = this.noiseBuffer;
    biteNoiseSrc.loop = true;

    this.csChainBiteFilter = this.ctx.createBiquadFilter();
    this.csChainBiteFilter.type = 'bandpass';
    this.csChainBiteFilter.frequency.value = 2400;
    this.csChainBiteFilter.Q.value = 1.6;

    this.csChainBiteGain = this.ctx.createGain();
    this.csChainBiteGain.gain.value = 0.0001;

    // Soft bus compressor so idle feels punchy and full-throttle roar feels massive without clipping
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 14;
    comp.ratio.value = 4.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.12;

    // Overall 2-stroke chainsaw bus volume (0 when deselected)
    this.csBusGain = this.ctx.createGain();
    this.csBusGain.gain.value = 0.0001;

    // Wire oscillators -> drive -> shaper -> muffler chain -> compressor -> bus -> master
    this.csEngineOsc.connect(this.csDriveGain);
    this.csSubOsc.connect(this.csSubGain);
    this.csSubGain.connect(this.csDriveGain);
    this.csPipeOsc.connect(this.csPipeGain);
    this.csPipeGain.connect(this.csDriveGain);

    this.csDriveGain.connect(shaper);
    shaper.connect(this.csMufflerLow);
    this.csMufflerLow.connect(this.csMufflerMid);
    this.csMufflerMid.connect(this.csMufflerHigh);
    this.csMufflerHigh.connect(comp);

    exhaustNoiseSrc.connect(this.csExhaustNoiseFilter);
    this.csExhaustNoiseFilter.connect(this.csExhaustNoiseGain);
    this.csExhaustNoiseGain.connect(comp);

    biteNoiseSrc.connect(this.csChainBiteFilter);
    this.csChainBiteFilter.connect(this.csChainBiteGain);
    this.csChainBiteGain.connect(comp);

    comp.connect(this.csBusGain);
    this.csBusGain.connect(this.masterGain);

    this.csEngineOsc.start();
    this.csSubOsc.start();
    this.csPipeOsc.start();
    exhaustNoiseSrc.start();
    biteNoiseSrc.start();
  }

  /**
   * Enable or disable the warm 2-stroke chainsaw engine idle when the Chainsaw tool is held.
   * Selecting the chainsaw triggers a quick authentic throttle blip ("brrr-BRAAP") before settling to idle.
   */
  public setChainsawSelected(selected: boolean): void {
    const wasSelected = this.csSelected;
    this.csSelected = selected;
    if (selected && !wasSelected) {
      // Quick warm throttle blip into classic 2-stroke idle!
      this.csBlipTimer = 0.34;
      if (this.csRpm < 1800) {
        this.csRpm = 2200;
      }
    } else if (!selected) {
      this.csCutting = false;
      this.csBlipTimer = 0;
    }
  }

  /**
   * Advance the 2-stroke chainsaw engine RPM physics, lopey idle flutter, wood-load lugging,
   * and deceleration coast-down every animation frame.
   */
  public update(dt: number): void {
    if (
      !this.initialized ||
      !this.ctx ||
      !this.csEngineOsc ||
      !this.csSubOsc ||
      !this.csPipeOsc ||
      !this.csSubGain ||
      !this.csPipeGain ||
      !this.csDriveGain ||
      !this.csMufflerMid ||
      !this.csMufflerHigh ||
      !this.csExhaustNoiseFilter ||
      !this.csExhaustNoiseGain ||
      !this.csChainBiteFilter ||
      !this.csChainBiteGain ||
      !this.csBusGain
    ) {
      return;
    }

    const now = this.ctx.currentTime;
    this.csClock += dt;

    if (!this.csSelected && !this.csCutting) {
      // Kill ignition smoothly
      this.csTargetRpm = 0;
      this.csRpm += (0 - this.csRpm) * Math.min(1, dt * 11);
      this.csBusGain.gain.setTargetAtTime(0.0001, now, 0.045);
      this.csChainBiteGain.gain.setTargetAtTime(0.0001, now, 0.03);
      if (this.csRpm > 80) {
        const hz = Math.max(18, this.csRpm / 60);
        this.csEngineOsc.frequency.setTargetAtTime(hz, now, 0.03);
        this.csSubOsc.frequency.setTargetAtTime(hz * 0.5, now, 0.03);
      }
      this.csPrevCutting = false;
      return;
    }

    // Track throttle blip timer on tool selection
    if (this.csBlipTimer > 0) {
      this.csBlipTimer = Math.max(0, this.csBlipTimer - dt);
    }

    // Compute target RPM
    if (this.csCutting) {
      // Heavy hardwoods lug the saw slightly deeper & throatier; softwoods scream higher!
      const densityLug = Math.max(0.84, Math.min(1.08, 1.12 - (this.csWoodDensity - 0.7) * 0.28));
      const baseCutRpm = (8500 + this.csCutIntensity * 1350) * densityLug;
      // Organic wood-grain load chatter (slight RPM surge & dip as teeth bite rings & knots)
      const grainLoad =
        Math.sin(this.csClock * 17.3) * 210 +
        Math.sin(this.csClock * 31.7) * 125 +
        Math.cos(this.csClock * 7.1) * 165;
      this.csTargetRpm = Math.max(7200, Math.min(11400, baseCutRpm + grainLoad));
    } else if (this.csBlipTimer > 0.14) {
      // Quick responsive throttle blip ("BRAAP!") when grabbing the chainsaw
      this.csTargetRpm = 7400;
    } else {
      // Classic warm 2-stroke idle (~2780 RPM) with uneven carbureted wander
      const idleWander =
        Math.sin(this.csClock * 3.1) * 130 +
        Math.sin(this.csClock * 7.9) * 95 +
        Math.cos(this.csClock * 13.4) * 70;
      this.csTargetRpm = 2780 + idleWander;
    }

    // Fast snappy throttle-up, heavier realistic flywheel coast-down on release
    const accelRate = this.csTargetRpm > this.csRpm ? 14.5 : this.csPrevCutting ? 6.2 : 8.5;
    this.csRpm += (this.csTargetRpm - this.csRpm) * Math.min(1, dt * accelRate);
    this.csPrevCutting = this.csCutting;

    // Normalize RPM (0 at ~2600 idle -> 1 at ~9800 full roar)
    const revNorm = Math.max(0, Math.min(1.15, (this.csRpm - 2600) / 7200));
    const idleFactor = Math.max(0, 1 - revNorm * 2.1);

    // Classic 2-stroke uneven "four-stroking" lope modulation at idle (putt-putt-PUG-putt!)
    this.csLopePhase += dt * (4.8 + revNorm * 14);
    const lopeWave =
      0.5 +
      0.5 * Math.sin(this.csLopePhase * 2.1) * Math.cos(this.csLopePhase * 0.77 + 0.4);
    const sputterPulse = 1 - idleFactor * (0.28 * lopeWave);
    const sputterPitch = 1 + idleFactor * (0.045 * (lopeWave - 0.5));

    // Firing frequency in Hz (2-stroke fires once per revolution!)
    const fireHz = Math.max(28, (this.csRpm / 60) * sputterPitch);

    this.csEngineOsc.frequency.setTargetAtTime(fireHz, now, 0.015);
    this.csSubOsc.frequency.setTargetAtTime(fireHz * 0.5, now, 0.015);
    this.csPipeOsc.frequency.setTargetAtTime(fireHz * 2.0, now, 0.015);

    // Sub-lope strong at idle (chugging crankcase), tightens up as engine gets "on the pipe"
    this.csSubGain.gain.setTargetAtTime(0.58 * idleFactor + 0.24 * (1 - idleFactor), now, 0.025);
    // 2nd-harmonic pipe scream rises dramatically during full-throttle wood cuts
    this.csPipeGain.gain.setTargetAtTime(0.05 + revNorm * 0.36, now, 0.025);
    // Waveshaper drive saturates hard under wood load for brawny bark
    this.csDriveGain.gain.setTargetAtTime(
      (0.95 + revNorm * 1.45 + (this.csCutting ? 0.35 : 0)) * sputterPulse,
      now,
      0.02
    );

    // Muffler box resonance tracks exhaust energy
    this.csMufflerMid.frequency.setTargetAtTime(520 + revNorm * 380, now, 0.03);
    this.csMufflerHigh.frequency.setTargetAtTime(
      1150 + revNorm * 3400 + (this.csCutting ? 750 : 0),
      now,
      0.03
    );

    // Exhaust air-puff & carburetor roar noise
    this.csExhaustNoiseFilter.frequency.setTargetAtTime(340 + revNorm * 880, now, 0.03);
    const exhaustNoiseLevel = (0.045 + revNorm * 0.16) * sputterPulse;
    this.csExhaustNoiseGain.gain.setTargetAtTime(exhaustNoiseLevel, now, 0.025);

    // Bar & chain ripping through wood fibers (only surges while cutting!)
    if (this.csCutting) {
      const teethChatter = 0.85 + 0.15 * Math.sin(this.csClock * 58);
      this.csChainBiteFilter.frequency.setTargetAtTime(
        1900 + revNorm * 1250 + Math.sin(this.csClock * 23) * 180,
        now,
        0.02
      );
      this.csChainBiteGain.gain.setTargetAtTime(0.145 * teethChatter, now, 0.025);
    } else {
      // Very faint warm clutch/chain idle whisper when not cutting
      this.csChainBiteGain.gain.setTargetAtTime(0.004 * idleFactor, now, 0.04);
    }

    // Overall bus gain: comfortable warm idle presence -> brawny commanding roar when cutting!
    const targetBusGain = this.csCutting
      ? 0.24 + Math.min(0.05, this.csCutIntensity * 0.03)
      : 0.088 + revNorm * 0.095;
    this.csBusGain.gain.setTargetAtTime(targetBusGain * (0.9 + 0.1 * sputterPulse), now, 0.03);
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

  public setSawActive(
    mode: 'none' | 'prune' | 'electric_buck' | 'chainsaw',
    intensity = 1,
    woodDensity = 1
  ): void {
    if (!this.ctx || !this.sawGain || !this.sawOsc || !this.sawSubOsc || !this.sawFilter) return;
    const now = this.ctx.currentTime;
    this.activeSawMode = mode;

    if (mode === 'none') {
      this.sawGain.gain.setTargetAtTime(0.0001, now, 0.05);
      this.csCutting = false;
      return;
    }

    if (mode === 'chainsaw') {
      // Silence electric synth and unleash the brawny 2-stroke chainsaw roar!
      this.sawGain.gain.setTargetAtTime(0.0001, now, 0.03);
      this.csCutting = true;
      this.csCutIntensity = intensity;
      this.csWoodDensity = woodDensity;
      return;
    }

    // Electric saws (Prune Saw & Limb/Buck): keep their pleasant electric whir!
    this.csCutting = false;
    if (mode === 'prune') {
      // Crisp rhythmic electric pole pruner hum
      const freq = 145 + intensity * 70 + Math.sin(now * 28) * 14;
      this.sawOsc.frequency.setTargetAtTime(freq, now, 0.03);
      this.sawSubOsc.frequency.setTargetAtTime(freq * 0.5, now, 0.03);
      this.sawFilter.frequency.setTargetAtTime(1100, now, 0.05);
      this.sawGain.gain.setTargetAtTime(0.085, now, 0.04);
    } else {
      // Pleasant torquey electric bucking/limbing saw hum (slightly deeper than prune saw)
      const flutter = Math.sin(now * 36) * 7;
      const freq = 92 + intensity * 52 + flutter;
      this.sawOsc.frequency.setTargetAtTime(freq, now, 0.03);
      this.sawSubOsc.frequency.setTargetAtTime(freq * 0.5, now, 0.03);
      this.sawFilter.frequency.setTargetAtTime(760 + intensity * 460, now, 0.05);
      this.sawGain.gain.setTargetAtTime(0.115, now, 0.04);
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

  /**
   * Synthesize a single realistic axe-head poll blow striking a forestry felling wedge ("tok!").
   * blowIndex 0 -> 1 -> 2 rises slightly in pitch and tightness as the wedge bites deeper into the kerf.
   */
  public playWedgeStrike(blowIndex = 0): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const pitchScale = 1 + Math.min(2, Math.max(0, blowIndex)) * 0.13 + (Math.random() - 0.5) * 0.025;

    // 1. Crisp wooden/polymer wedge "TOK!" body impact
    const tokOsc = this.ctx.createOscillator();
    tokOsc.type = 'triangle';
    tokOsc.frequency.setValueAtTime(340 * pitchScale, now);
    tokOsc.frequency.exponentialRampToValueAtTime(118 * pitchScale, now + 0.095);

    const tokFilter = this.ctx.createBiquadFilter();
    tokFilter.type = 'bandpass';
    tokFilter.frequency.setValueAtTime(520 * pitchScale, now);
    tokFilter.Q.value = 1.8;

    const tokGain = this.ctx.createGain();
    tokGain.gain.setValueAtTime(0.46, now);
    tokGain.gain.exponentialRampToValueAtTime(0.001, now + 0.115);

    tokOsc.connect(tokFilter);
    tokFilter.connect(tokGain);
    tokGain.connect(this.masterGain);
    tokOsc.start(now);
    tokOsc.stop(now + 0.125);

    // 2. Deep standing-trunk wood thump as the shockwave enters the timber
    const thumpOsc = this.ctx.createOscillator();
    thumpOsc.type = 'sine';
    thumpOsc.frequency.setValueAtTime(115 * (0.95 + blowIndex * 0.06), now);
    thumpOsc.frequency.exponentialRampToValueAtTime(48, now + 0.14);

    const thumpGain = this.ctx.createGain();
    thumpGain.gain.setValueAtTime(0.32, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.155);

    thumpOsc.connect(thumpGain);
    thumpGain.connect(this.masterGain);
    thumpOsc.start(now);
    thumpOsc.stop(now + 0.165);

    // 3. Forged steel axe-poll knock transient + tight metallic overtone
    if (this.noiseBuffer) {
      const nSrc = this.ctx.createBufferSource();
      nSrc.buffer = this.noiseBuffer;
      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = 'bandpass';
      nFilter.frequency.setValueAtTime(1950 * pitchScale, now);
      nFilter.Q.value = 2.2;

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.34, now);
      nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.042);

      nSrc.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(this.masterGain);
      nSrc.start(now);
      nSrc.stop(now + 0.05);
    }

    // Subtle damped axe-head steel ring (two short inharmonic partials)
    for (const [freq, amp, dur] of [
      [1720 * pitchScale, 0.085, 0.075],
      [2680 * pitchScale, 0.045, 0.055],
    ] as const) {
      const ring = this.ctx.createOscillator();
      ring.type = 'sine';
      ring.frequency.setValueAtTime(freq, now);
      ring.frequency.exponentialRampToValueAtTime(freq * 0.94, now + dur);

      const rGain = this.ctx.createGain();
      rGain.gain.setValueAtTime(amp, now);
      rGain.gain.exponentialRampToValueAtTime(0.0008, now + dur);

      ring.connect(rGain);
      rGain.connect(this.masterGain);
      ring.start(now);
      ring.stop(now + dur + 0.01);
    }
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
