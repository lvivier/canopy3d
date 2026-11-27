import { SiteId, SpeciesSpec, WeatherId } from '../types';

interface SiteAcousticProfile {
  /** Stereo reverb tail length in seconds */
  reverbDecay: number;
  /** Early slap/reflection pre-delay in seconds */
  preDelay: number;
  /** Warmth low-pass cutoff on wet reverb tail (Hz) */
  reverbLowpass: number;
  /** Wet reverb return level */
  reverbWet: number;
  /** Subtle babbling creek murmur level (Misty Valley Creek) */
  creekGain: number;
  /** Distant rolling ocean surf level (Headland / Storm Bluff) */
  surfGain: number;
  /** Early-reflection density (higher = thick forest canopy, lower = crisp rock slap) */
  canopyDensity: number;
}

const SITE_ACOUSTICS: Record<SiteId, SiteAcousticProfile> = {
  coastal_homestead: {
    // Deep coastal woods: lush, warm timber canopy reverb
    reverbDecay: 1.4,
    preDelay: 0.018,
    reverbLowpass: 2350,
    reverbWet: 0.34,
    creekGain: 0,
    surfGain: 0,
    canopyDensity: 0.85,
  },
  timber_ridge: {
    // Towering old-growth ridge: expansive cathedral-like woodland tail
    reverbDecay: 1.75,
    preDelay: 0.024,
    reverbLowpass: 2650,
    reverbWet: 0.38,
    creekGain: 0,
    surfGain: 0,
    canopyDensity: 0.78,
  },
  misty_creek: {
    // Damp mossy river hollow: rich wet woodland reverb + babbling stream
    reverbDecay: 1.5,
    preDelay: 0.02,
    reverbLowpass: 2150,
    reverbWet: 0.36,
    creekGain: 0.068,
    surfGain: 0,
    canopyDensity: 0.9,
  },
  kootenay_rockies: {
    // Crisp interior mountain valley: distinct alpine ridge echo & brighter stone reflection
    reverbDecay: 1.9,
    preDelay: 0.04,
    reverbLowpass: 3650,
    reverbWet: 0.3,
    creekGain: 0,
    surfGain: 0,
    canopyDensity: 0.42,
  },
  pacific_headland: {
    // Open coastal savanna bluff: airy dry acoustics + distant Pacific swell
    reverbDecay: 0.75,
    preDelay: 0.012,
    reverbLowpass: 3200,
    reverbWet: 0.14,
    creekGain: 0,
    surfGain: 0.072,
    canopyDensity: 0.35,
  },
  storm_bluff: {
    // Exposed sea cliff: brisk open bluff reflection + rolling ocean surf
    reverbDecay: 0.82,
    preDelay: 0.014,
    reverbLowpass: 3000,
    reverbWet: 0.16,
    creekGain: 0,
    surfGain: 0.09,
    canopyDensity: 0.32,
  },
  coastal_town: {
    // Residential neighborhood yard: tight, intimate short clap off siding & fences
    reverbDecay: 0.46,
    preDelay: 0.009,
    reverbLowpass: 3350,
    reverbWet: 0.15,
    creekGain: 0,
    surfGain: 0,
    canopyDensity: 0.55,
  },
};

/**
 * Procedural Web Audio Engine for Canopy 3D.
 * Synthesizes forest wind ambience, light rain & canopy drips, site-specific
 * acoustic reverb (deep-woods canopy, alpine valley echo, coastal bluff surf,
 * valley creek murmur), distant birds, electric pruning saw, a realistic two-stroke
 * chainsaw (lopey carbureted idle, throttle blip, brawny wood-loaded roar,
 * bar/chain rasp, and coast-down), wedge hammer hits, species-tuned hinge
 * snapping/splitting/creaking, live falling foliage air-rush, timber impact crash,
 * and pleasant UI/success chimes.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private worldBus: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  // Environment acoustic space (convolution reverb + weather/site ambience)
  private envPreDelay: DelayNode | null = null;
  private envReverbTone: BiquadFilterNode | null = null;
  private envConvolver: ConvolverNode | null = null;
  private envReverbWet: GainNode | null = null;
  private irCache = new Map<SiteId, AudioBuffer>();

  // Light rain dual-band synth (leafy canopy patter + soft ground drizzle)
  private rainCanopyGain: GainNode | null = null;
  private rainCanopyFilter: BiquadFilterNode | null = null;
  private rainBedGain: GainNode | null = null;
  private rainBedFilter: BiquadFilterNode | null = null;

  // Site water beds (babbling creek & distant ocean surf)
  private creekGain: GainNode | null = null;
  private creekFilter: BiquadFilterNode | null = null;
  private surfGain: GainNode | null = null;
  private surfFilter: BiquadFilterNode | null = null;

  private currentSite: SiteId = 'coastal_homestead';
  private currentWeather: WeatherId = 'sunny_morning';
  private currentWindSpeed = 0.18;
  private ambienceClock = 0;
  private nextRainDripAt = 0.7;

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

  // Live falling-tree air-rush & foliage rustle voice
  private fallVoice: {
    whooshSrc: AudioBufferSourceNode;
    whooshFilter: BiquadFilterNode;
    whooshGain: GainNode;
    rustleSrc: AudioBufferSourceNode;
    rustleFilter: BiquadFilterNode;
    rustleGain: GainNode;
    height: number;
    species: SpeciesSpec;
    tearCrackFired: boolean;
    clock: number;
  } | null = null;

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

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.65;
      this.masterGain.connect(this.ctx.destination);

      // World SFX bus splits to dry master + site-specific convolution reverb
      this.worldBus = this.ctx.createGain();
      this.worldBus.gain.value = 1.0;
      this.worldBus.connect(this.masterGain);

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

      this.setupEnvironmentReverb();
      this.setupWindAmbience();
      this.setupWeatherAndSiteAmbience();
      this.setupSawSynth();
      this.setupTwoStrokeChainsaw();
      this.startBirdAmbience();
      this.initialized = true;
      this.applyEnvironmentState();
    } catch {
      // AudioContext unavailable
    }
  }

  private getOrCreateSiteImpulse(site: SiteId): AudioBuffer | null {
    if (!this.ctx) return null;
    const cached = this.irCache.get(site);
    if (cached) return cached;

    const p = SITE_ACOUSTICS[site];
    const sr = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(sr * p.reverbDecay));
    const buf = this.ctx.createBuffer(2, length, sr);

    // Deterministic seeded noise so each environment's space feels consistent
    let seed = site.split('').reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 17) >>> 0;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };

    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      // Woodland foliage absorbs highs progressively deeper into the tail
      const dampBase = 0.25 + (1 - p.canopyDensity) * 0.45;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        // Smooth bloom on attack (~18ms) followed by natural exponential decay
        const attack = Math.min(1, i / (sr * 0.018));
        const env = attack * Math.pow(1 - t, 2.35) * Math.exp(-t * 2.4);
        const raw = nextRand();
        const alpha = Math.max(0.06, dampBase * (1 - t * 0.72));
        lp += (raw - lp) * alpha;
        data[i] = lp * env;
      }

      // Distinct early reflections (nearby trunks, house siding, or alpine cliff walls)
      const earlyCount = Math.round(5 + p.canopyDensity * 8);
      for (let e = 0; e < earlyCount; e++) {
        const delaySec =
          site === 'kootenay_rockies'
            ? 0.055 + e * 0.042 + Math.abs(nextRand()) * 0.025
            : 0.012 + e * 0.017 + Math.abs(nextRand()) * 0.014;
        const idx = Math.floor(delaySec * sr);
        if (idx > 0 && idx < length) {
          const amp = (0.32 / (1 + e * 0.35)) * (ch === 0 ? 1 : 0.92);
          data[idx] += (nextRand() >= 0 ? 1 : -1) * amp;
        }
      }
    }

    this.irCache.set(site, buf);
    return buf;
  }

  private setupEnvironmentReverb(): void {
    if (!this.ctx || !this.masterGain || !this.worldBus) return;
    this.envPreDelay = this.ctx.createDelay(0.15);
    this.envPreDelay.delayTime.value = 0.018;

    this.envReverbTone = this.ctx.createBiquadFilter();
    this.envReverbTone.type = 'lowpass';
    this.envReverbTone.frequency.value = 2400;
    this.envReverbTone.Q.value = 0.7;

    this.envConvolver = this.ctx.createConvolver();
    const initialIr = this.getOrCreateSiteImpulse(this.currentSite);
    if (initialIr) this.envConvolver.buffer = initialIr;

    this.envReverbWet = this.ctx.createGain();
    this.envReverbWet.gain.value = 0.25;

    this.worldBus.connect(this.envPreDelay);
    this.envPreDelay.connect(this.envReverbTone);
    this.envReverbTone.connect(this.envConvolver);
    this.envConvolver.connect(this.envReverbWet);
    this.envReverbWet.connect(this.masterGain);
  }

  private setupWeatherAndSiteAmbience(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;

    // 1. Light Rain: delicate canopy needle/leaf patter + warm ground drizzle bed
    const rainCanopySrc = this.ctx.createBufferSource();
    rainCanopySrc.buffer = this.noiseBuffer;
    rainCanopySrc.loop = true;

    this.rainCanopyFilter = this.ctx.createBiquadFilter();
    this.rainCanopyFilter.type = 'bandpass';
    this.rainCanopyFilter.frequency.value = 2400;
    this.rainCanopyFilter.Q.value = 0.65;

    this.rainCanopyGain = this.ctx.createGain();
    this.rainCanopyGain.gain.value = 0.0001;

    rainCanopySrc.connect(this.rainCanopyFilter);
    this.rainCanopyFilter.connect(this.rainCanopyGain);
    this.rainCanopyGain.connect(this.masterGain);
    rainCanopySrc.start(0, 0.4);

    const rainBedSrc = this.ctx.createBufferSource();
    rainBedSrc.buffer = this.noiseBuffer;
    rainBedSrc.loop = true;

    this.rainBedFilter = this.ctx.createBiquadFilter();
    this.rainBedFilter.type = 'bandpass';
    this.rainBedFilter.frequency.value = 780;
    this.rainBedFilter.Q.value = 0.55;

    this.rainBedGain = this.ctx.createGain();
    this.rainBedGain.gain.value = 0.0001;

    rainBedSrc.connect(this.rainBedFilter);
    this.rainBedFilter.connect(this.rainBedGain);
    this.rainBedGain.connect(this.masterGain);
    rainBedSrc.start(0, 1.3);

    // 2. Babbling valley creek water murmur (Misty Valley Creek)
    const creekSrc = this.ctx.createBufferSource();
    creekSrc.buffer = this.noiseBuffer;
    creekSrc.loop = true;

    this.creekFilter = this.ctx.createBiquadFilter();
    this.creekFilter.type = 'bandpass';
    this.creekFilter.frequency.value = 920;
    this.creekFilter.Q.value = 1.1;

    this.creekGain = this.ctx.createGain();
    this.creekGain.gain.value = 0.0001;

    creekSrc.connect(this.creekFilter);
    this.creekFilter.connect(this.creekGain);
    this.creekGain.connect(this.masterGain);
    creekSrc.start(0, 0.8);

    // 3. Distant rolling Pacific surf (Headland & Storm Bluff)
    const surfSrc = this.ctx.createBufferSource();
    surfSrc.buffer = this.noiseBuffer;
    surfSrc.loop = true;

    this.surfFilter = this.ctx.createBiquadFilter();
    this.surfFilter.type = 'lowpass';
    this.surfFilter.frequency.value = 340;
    this.surfFilter.Q.value = 0.7;

    this.surfGain = this.ctx.createGain();
    this.surfGain.gain.value = 0.0001;

    surfSrc.connect(this.surfFilter);
    this.surfFilter.connect(this.surfGain);
    this.surfGain.connect(this.masterGain);
    surfSrc.start(0, 1.9);
  }

  /**
   * Configure environment acoustics (site-specific reverb, valley creek, ocean surf)
   * and weather soundscape (e.g. gentle light rain patter & canopy drips).
   */
  public setEnvironment(site: SiteId, weather: WeatherId): void {
    this.currentSite = site;
    this.currentWeather = weather;
    if (this.initialized) {
      this.applyEnvironmentState();
    }
  }

  private applyEnvironmentState(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const p = SITE_ACOUSTICS[this.currentSite];
    const isRain = this.currentWeather === 'light_rain';

    // Update convolution reverb space & tone
    if (this.envConvolver) {
      const ir = this.getOrCreateSiteImpulse(this.currentSite);
      if (ir && this.envConvolver.buffer !== ir) {
        this.envConvolver.buffer = ir;
      }
    }
    if (this.envPreDelay) {
      this.envPreDelay.delayTime.setTargetAtTime(p.preDelay, now, 0.15);
    }
    if (this.envReverbTone) {
      // Wet rain-soaked foliage subtly softens high reflections even further
      const cutoff = isRain ? p.reverbLowpass * 0.84 : p.reverbLowpass;
      this.envReverbTone.frequency.setTargetAtTime(cutoff, now, 0.25);
    }
    if (this.envReverbWet) {
      this.envReverbWet.gain.setTargetAtTime(p.reverbWet, now, 0.25);
    }

    // Light rain bed: slightly richer canopy patter in wooded sites vs open sites
    const canopyBoost = 0.8 + p.canopyDensity * 0.45;
    if (this.rainCanopyGain && this.rainCanopyFilter) {
      this.rainCanopyGain.gain.setTargetAtTime(isRain ? 0.088 * canopyBoost : 0.0001, now, 0.45);
      this.rainCanopyFilter.frequency.setTargetAtTime(
        2050 + p.canopyDensity * 550,
        now,
        0.45
      );
    }
    if (this.rainBedGain) {
      this.rainBedGain.gain.setTargetAtTime(isRain ? 0.056 : 0.0001, now, 0.45);
    }

    // Site water ambience (creek & ocean surf)
    if (this.creekGain) {
      this.creekGain.gain.setTargetAtTime(Math.max(0.0001, p.creekGain), now, 0.5);
    }
    if (this.surfGain) {
      this.surfGain.gain.setTargetAtTime(Math.max(0.0001, p.surfGain), now, 0.5);
    }

    // Re-apply wind filter balance for rain vs dry air
    this.setWindLevel(this.currentWindSpeed);
  }

  private playRainDrip(): void {
    if (!this.ctx || !this.worldBus) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const startFreq = 920 + Math.random() * 1100;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(startFreq * (1.35 + Math.random() * 0.25), now + 0.036);

    const gain = this.ctx.createGain();
    const peak = 0.012 + Math.random() * 0.014;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);

    osc.connect(gain);
    gain.connect(this.worldBus);
    osc.start(now);
    osc.stop(now + 0.065);
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
    if (!this.ctx || !this.worldBus) return;
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
    this.sawGain.connect(this.worldBus);

    this.sawOsc.start();
    this.sawSubOsc.start();
  }

  private setupTwoStrokeChainsaw(): void {
    if (!this.ctx || !this.worldBus || !this.noiseBuffer) return;

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
    this.csBusGain.connect(this.worldBus);

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

    // Living weather & site ambience modulation (rain drips, creek burble, slow ocean surf swell)
    this.ambienceClock += dt;
    const siteProfile = SITE_ACOUSTICS[this.currentSite];
    if (this.currentWeather === 'light_rain') {
      if (this.rainCanopyFilter) {
        const gustShimmer = Math.sin(this.ambienceClock * 0.7) * 180 + Math.sin(this.ambienceClock * 1.9) * 90;
        this.rainCanopyFilter.frequency.setTargetAtTime(
          2050 + siteProfile.canopyDensity * 550 + gustShimmer,
          now,
          0.18
        );
      }
      if (!this.muted && this.ctx.state === 'running' && this.ambienceClock >= this.nextRainDripAt) {
        this.playRainDrip();
        this.nextRainDripAt = this.ambienceClock + 0.35 + Math.random() * 0.95;
      }
    }
    if (siteProfile.creekGain > 0 && this.creekFilter && this.creekGain) {
      const burble = Math.sin(this.ambienceClock * 2.1) * 140 + Math.sin(this.ambienceClock * 4.7) * 75;
      this.creekFilter.frequency.setTargetAtTime(920 + burble, now, 0.14);
      this.creekGain.gain.setTargetAtTime(
        siteProfile.creekGain * (0.9 + 0.1 * Math.sin(this.ambienceClock * 1.15)),
        now,
        0.18
      );
    }
    if (siteProfile.surfGain > 0 && this.surfFilter && this.surfGain) {
      // Slow 8-second rolling Pacific wave swell
      const swell = 0.5 + 0.5 * Math.sin(this.ambienceClock * 0.78);
      this.surfFilter.frequency.setTargetAtTime(220 + swell * 240, now, 0.25);
      this.surfGain.gain.setTargetAtTime(siteProfile.surfGain * (0.58 + swell * 0.55), now, 0.25);
    }
  }

  private startBirdAmbience(): void {
    const schedule = () => {
      const rainDelay = this.currentWeather === 'light_rain' ? 1.8 : 1.0;
      const delay = (5500 + Math.random() * 11000) * rainDelay;
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
    if (!this.ctx || !this.worldBus) return;
    const now = this.ctx.currentTime;
    const baseFreq = 2100 + Math.random() * 1400;
    const chirps = Math.random() > 0.4 ? 2 : 3;
    const rainQuiet = this.currentWeather === 'light_rain' ? 0.6 : 1.0;

    for (let i = 0; i < chirps; i++) {
      const t = now + i * 0.16;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * (1.18 + Math.random() * 0.12), t + 0.07);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.92, t + 0.13);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.018 * rainQuiet, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

      osc.connect(gain);
      gain.connect(this.worldBus);
      osc.start(t);
      osc.stop(t + 0.15);
    }
  }

  public setWindLevel(windSpeed: number): void {
    this.currentWindSpeed = windSpeed;
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    const now = this.ctx.currentTime;
    const clamped = Math.max(0.05, Math.min(1, windSpeed));
    const rainSoften = this.currentWeather === 'light_rain' ? 0.8 : 1.0;
    this.windGain.gain.setTargetAtTime((0.05 + clamped * 0.16) * rainSoften, now, 0.4);
    this.windFilter.frequency.setTargetAtTime(
      (260 + clamped * 480) * (this.currentWeather === 'light_rain' ? 0.86 : 1.0),
      now,
      0.4
    );
  }

  public setSawActive(
    mode: 'none' | 'prune' | 'chainsaw',
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

    // Electric Prune Saw: crisp rhythmic electric pole pruner hum
    this.csCutting = false;
    const freq = 145 + intensity * 70 + Math.sin(now * 28) * 14;
    this.sawOsc.frequency.setTargetAtTime(freq, now, 0.03);
    this.sawSubOsc.frequency.setTargetAtTime(freq * 0.5, now, 0.03);
    this.sawFilter.frequency.setTargetAtTime(1100, now, 0.05);
    this.sawGain.gain.setTargetAtTime(0.085, now, 0.04);
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
    gain.connect(this.worldBus ?? this.masterGain);
    src.start(now);
    src.stop(now + 0.2);
  }

  /**
   * Synthesize a single realistic axe-head poll blow striking a forestry felling wedge ("tok!").
   * blowIndex 0 -> 1 -> 2 rises slightly in pitch and tightness as the wedge bites deeper into the kerf.
   */
  public playWedgeStrike(blowIndex = 0): void {
    if (!this.ctx || !this.masterGain) return;
    const out = this.worldBus ?? this.masterGain;
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
    tokGain.connect(out);
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
    thumpGain.connect(out);
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
      nGain.connect(out);
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
      rGain.connect(out);
      ring.start(now);
      ring.stop(now + dur + 0.01);
    }
  }

  /**
   * Derive species-specific wood & foliage acoustic characteristics for felling sounds.
   */
  private getSpeciesAcoustics(species?: SpeciesSpec): {
    woodPitch: number;
    crackSharpness: number;
    fiberStringiness: number;
    foliageBrightness: number;
    leafFlutter: number;
    massFactor: number;
  } {
    if (!species) {
      return {
        woodPitch: 1.0,
        crackSharpness: 1.0,
        fiberStringiness: 0.5,
        foliageBrightness: 1.0,
        leafFlutter: 0.4,
        massFactor: 1.0,
      };
    }

    const id = species.id;
    const isConifer = species.category === 'conifer';
    const density = species.woodDensity;

    // Dense hardwoods have deeper resonant groans & explosive sharp cracks;
    // soft poplars/alders pop higher & brisker; cedar/redwood/eucalyptus tear in long stringy fibers.
    const isStringy =
      id === 'western_red_cedar' ||
      id === 'yellow_cedar' ||
      id === 'california_redwood' ||
      id === 'giant_sequoia' ||
      id === 'eucalyptus' ||
      id === 'western_hemlock' ||
      id === 'windmill_palm';
    const isBrittlePop =
      id === 'trembling_aspen' ||
      id === 'white_poplar' ||
      id === 'red_alder' ||
      id === 'weeping_willow';
    const isDenseHardwood =
      id === 'garry_oak' ||
      id === 'bigleaf_maple' ||
      id === 'arbutus' ||
      id === 'japanese_maple' ||
      id === 'chokecherry' ||
      id === 'lilac';
    const isGiant =
      id === 'giant_sequoia' ||
      id === 'california_redwood' ||
      id === 'douglas_fir' ||
      id === 'western_larch';

    const woodPitch = isGiant
      ? 0.78
      : isDenseHardwood
        ? 0.88
        : isBrittlePop
          ? 1.24
          : isStringy
            ? 0.92
            : 1.0;

    const crackSharpness = isDenseHardwood
      ? 1.35
      : id === 'western_larch' || id === 'eucalyptus'
        ? 1.25
        : isBrittlePop
          ? 1.15
          : isStringy
            ? 0.82
            : 1.05;

    const fiberStringiness = isStringy
      ? 1.0
      : id === 'douglas_fir' || id === 'ponderosa_pine' || id === 'western_larch'
        ? 0.65
        : isDenseHardwood
          ? 0.55
          : 0.3;

    // Foliage air-rush character: trembling aspen / poplar / willow shimmer high & papery;
    // bigleaf maple / oak rush full-bodied; conifers sizzle with airy pine-needle whoosh.
    const foliageBrightness =
      id === 'trembling_aspen' || id === 'white_poplar' || id === 'weeping_willow'
        ? 1.35
        : id === 'windmill_palm'
          ? 1.24
          : id === 'western_larch'
            ? 1.18
            : isConifer
              ? 0.92
              : 1.08;

    const leafFlutter =
      id === 'trembling_aspen' || id === 'white_poplar'
        ? 1.0
        : id === 'windmill_palm'
          ? 0.88
          : isConifer
            ? 0.25
            : 0.78;

    const massFactor = Math.max(0.7, Math.min(1.45, 0.65 + density * 0.45));

    return {
      woodPitch,
      crackSharpness,
      fiberStringiness,
      foliageBrightness,
      leafFlutter,
      massFactor,
    };
  }

  /**
   * Schedule a single sharp wood-fiber snap / rifle-crack / splinter burst at absolute AudioContext time `t`.
   */
  private scheduleWoodCrack(
    t: number,
    intensity: number,
    pitchScale: number,
    sharpness: number,
    stringy: boolean
  ): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;

    // 1. Sharp fiber-snap impulse burst
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const offset = Math.random() * 2.0;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime((1250 + Math.random() * 1100) * pitchScale * sharpness, t);
    bp.frequency.exponentialRampToValueAtTime(340 * pitchScale, t + (stringy ? 0.14 : 0.065));
    bp.Q.value = stringy ? 1.5 : 2.6;

    const nGain = this.ctx.createGain();
    const dur = stringy ? 0.12 + Math.random() * 0.09 : 0.045 + Math.random() * 0.045;
    nGain.gain.setValueAtTime(0.0001, t);
    nGain.gain.linearRampToValueAtTime(0.32 * intensity * Math.min(1.3, sharpness), t + 0.004);
    nGain.gain.exponentialRampToValueAtTime(0.0008, t + dur);

    src.connect(bp);
    bp.connect(nGain);
    nGain.connect(this.worldBus ?? this.masterGain);
    src.start(t, offset, dur + 0.02);

    // 2. Woody resonant body "pop / crack" transient
    const pop = this.ctx.createOscillator();
    pop.type = 'triangle';
    const fStart = (290 + Math.random() * 190) * pitchScale;
    pop.frequency.setValueAtTime(fStart, t);
    pop.frequency.exponentialRampToValueAtTime(fStart * 0.36, t + 0.075);

    const pGain = this.ctx.createGain();
    pGain.gain.setValueAtTime(0.24 * intensity, t);
    pGain.gain.exponentialRampToValueAtTime(0.0008, t + 0.085);

    pop.connect(pGain);
    pGain.connect(this.worldBus ?? this.masterGain);
    pop.start(t);
    pop.stop(t + 0.095);
  }

  /**
   * Begin the cinematic falling-tree soundscape:
   * 1) Species-tuned hinge groaning, fiber splitting, and rifle-crack snaps as the tree breaks free
   * 2) A live accelerating air-rush & foliage-rustle voice updated every frame until ground impact
   */
  public startTreeFallSound(species: SpeciesSpec, height: number, severedHinge = false): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    this.stopTreeFallSound();

    const now = this.ctx.currentTime;
    const ac = this.getSpeciesAcoustics(species);
    const sizeScale = Math.max(0.65, Math.min(1.45, height / 20));

    // A. Deep bending hinge-wood groans (sawtooth through resonant wood-cavity bandpass)
    const groanCount = severedHinge ? 2 : 3;
    for (let i = 0; i < groanCount; i++) {
      const t = now + i * 0.21 + Math.random() * 0.04;
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      const f0 = (112 + Math.random() * 58) * ac.woodPitch;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.56, t + 0.28);

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(420 * ac.woodPitch, t);
      filter.frequency.linearRampToValueAtTime(260 * ac.woodPitch, t + 0.28);
      filter.Q.value = 4.2;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0008, t);
      gain.gain.linearRampToValueAtTime(0.15 * ac.massFactor * sizeScale, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.31);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.worldBus ?? this.masterGain);
      osc.start(t);
      osc.stop(t + 0.33);
    }

    // B. Sequential hinge-wood snapping, splitting & splintering cracks!
    const snapTimes = severedHinge
      ? [0.0, 0.04, 0.11, 0.2, 0.33, 0.48]
      : [0.02, 0.13, 0.24, 0.38, 0.54, 0.72];

    snapTimes.forEach((delay, idx) => {
      const jitter = idx === 0 ? 0 : (Math.random() - 0.5) * 0.04;
      const t = now + Math.max(0, delay + jitter);
      const isBigSplit = severedHinge ? idx <= 1 : idx === 2 || idx === 4;
      const isStringyRip = ac.fiberStringiness > 0.6 && (idx === 1 || idx === 3 || idx === 5);
      const amp = (isBigSplit ? 1.15 : 0.65 + Math.random() * 0.3) * sizeScale;
      this.scheduleWoodCrack(
        t,
        amp,
        ac.woodPitch * (0.9 + Math.random() * 0.25),
        ac.crackSharpness,
        isStringyRip
      );
    });

    // Extra longitudinal fiber-tearing rip for fibrous conifers & stringy eucalyptus
    if (ac.fiberStringiness >= 0.65) {
      const ripStart = now + 0.16;
      const ripDur = 0.42;
      const ripSrc = this.ctx.createBufferSource();
      ripSrc.buffer = this.noiseBuffer;
      const ripFilter = this.ctx.createBiquadFilter();
      ripFilter.type = 'bandpass';
      ripFilter.frequency.setValueAtTime(680 * ac.woodPitch, ripStart);
      ripFilter.frequency.exponentialRampToValueAtTime(1480 * ac.woodPitch, ripStart + ripDur);
      ripFilter.Q.value = 2.0;

      const ripGain = this.ctx.createGain();
      ripGain.gain.setValueAtTime(0.0008, ripStart);
      ripGain.gain.linearRampToValueAtTime(0.16 * ac.fiberStringiness * sizeScale, ripStart + 0.1);
      ripGain.gain.exponentialRampToValueAtTime(0.0008, ripStart + ripDur);

      ripSrc.connect(ripFilter);
      ripFilter.connect(ripGain);
      ripGain.connect(this.worldBus ?? this.masterGain);
      ripSrc.start(ripStart, Math.random() * 1.5, ripDur + 0.04);
    }

    // C. Continuous live air-rush + species-tuned foliage rustle during the fall!
    const whooshSrc = this.ctx.createBufferSource();
    whooshSrc.buffer = this.noiseBuffer;
    whooshSrc.loop = true;

    const whooshFilter = this.ctx.createBiquadFilter();
    whooshFilter.type = 'bandpass';
    whooshFilter.frequency.value = 180;
    whooshFilter.Q.value = 0.85;

    const whooshGain = this.ctx.createGain();
    whooshGain.gain.value = 0.0001;

    whooshSrc.connect(whooshFilter);
    whooshFilter.connect(whooshGain);
    whooshGain.connect(this.worldBus ?? this.masterGain);
    whooshSrc.start(now, Math.random() * 2);

    const rustleSrc = this.ctx.createBufferSource();
    rustleSrc.buffer = this.noiseBuffer;
    rustleSrc.loop = true;

    const rustleFilter = this.ctx.createBiquadFilter();
    rustleFilter.type = 'bandpass';
    rustleFilter.frequency.value = 1850 * ac.foliageBrightness;
    rustleFilter.Q.value = species.category === 'conifer' ? 1.1 : 1.65;

    const rustleGain = this.ctx.createGain();
    rustleGain.gain.value = 0.0001;

    rustleSrc.connect(rustleFilter);
    rustleFilter.connect(rustleGain);
    rustleGain.connect(this.worldBus ?? this.masterGain);
    rustleSrc.start(now, Math.random() * 2);

    this.fallVoice = {
      whooshSrc,
      whooshFilter,
      whooshGain,
      rustleSrc,
      rustleFilter,
      rustleGain,
      height,
      species,
      tearCrackFired: false,
      clock: 0,
    };
  }

  /**
   * Modulate the falling tree's air-rush whoosh and foliage rustle in real time as it accelerates.
   */
  public updateTreeFallSound(fallAngle: number, fallVelocity: number, dt: number): void {
    const fv = this.fallVoice;
    if (!fv || !this.ctx) return;

    const now = this.ctx.currentTime;
    fv.clock += dt;
    const ac = this.getSpeciesAcoustics(fv.species);

    // Mid-fall final hinge-fiber break right as gravity takes full hold!
    if (!fv.tearCrackFired && fallAngle >= 0.42) {
      fv.tearCrackFired = true;
      const sizeScale = Math.max(0.7, Math.min(1.4, fv.height / 20));
      this.scheduleWoodCrack(
        now,
        1.1 * sizeScale,
        ac.woodPitch * 0.92,
        ac.crackSharpness,
        ac.fiberStringiness > 0.55
      );
      this.scheduleWoodCrack(
        now + 0.055,
        0.75 * sizeScale,
        ac.woodPitch * 1.12,
        ac.crackSharpness,
        false
      );
    }

    // Crown tip speed scales both the low air-displacement whoosh and high leaf/needle rustle
    const tipSpeed = Math.min(1.35, (fallVelocity * Math.sqrt(fv.height / 18)) / 2.2);
    const angleProgress = Math.min(1, fallAngle / (Math.PI * 0.5));
    const rushEnergy = Math.min(1.2, tipSpeed * (0.35 + angleProgress * 0.85));
    const sizeScale = Math.max(0.65, Math.min(1.35, fv.height / 20));

    // Low-mid air whoosh sweeps up as the crown whips downward
    const whooshFreq = 170 + rushEnergy * 540;
    fv.whooshFilter.frequency.setTargetAtTime(whooshFreq, now, 0.035);
    fv.whooshGain.gain.setTargetAtTime(Math.min(0.32, rushEnergy * 0.24 * sizeScale), now, 0.04);

    // Species-tuned foliage rustle: fluttering papery leaves vs. airy conifer needle hiss
    const flutter =
      1 +
      ac.leafFlutter *
        (0.24 * Math.sin(fv.clock * 29) + 0.16 * Math.cos(fv.clock * 47.3));
    const rustleFreq = (1550 + rushEnergy * 1950) * ac.foliageBrightness;
    fv.rustleFilter.frequency.setTargetAtTime(Math.min(6200, rustleFreq), now, 0.035);
    fv.rustleGain.gain.setTargetAtTime(
      Math.min(0.26, rushEnergy * 0.19 * sizeScale * flutter),
      now,
      0.035
    );
  }

  public stopTreeFallSound(): void {
    const fv = this.fallVoice;
    if (!fv || !this.ctx) {
      this.fallVoice = null;
      return;
    }
    const now = this.ctx.currentTime;
    fv.whooshGain.gain.setTargetAtTime(0.0001, now, 0.03);
    fv.rustleGain.gain.setTargetAtTime(0.0001, now, 0.03);
    try {
      fv.whooshSrc.stop(now + 0.14);
      fv.rustleSrc.stop(now + 0.14);
    } catch {
      // already stopped
    }
    this.fallVoice = null;
  }

  public playTimberCreak(species?: SpeciesSpec, height = 20): void {
    if (species) {
      this.startTreeFallSound(species, height, false);
      return;
    }
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
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
      gain.connect(this.worldBus ?? this.masterGain);
      osc.start(t);
      osc.stop(t + 0.24);
    }
  }

  public playTimberCrash(weightScale = 1, species?: SpeciesSpec): void {
    this.stopTreeFallSound();
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const out = this.worldBus ?? this.masterGain;
    const now = this.ctx.currentTime;
    const ac = this.getSpeciesAcoustics(species);
    const heavyScale = Math.min(1.5, weightScale * ac.massFactor);

    // 1. Deep earth-shaking bass thump (heavier/lower for dense hardwoods & giant redwoods/firs)
    const bass = this.ctx.createOscillator();
    bass.type = 'sine';
    bass.frequency.setValueAtTime(88 / Math.sqrt(ac.massFactor), now);
    bass.frequency.exponentialRampToValueAtTime(22, now + 0.68);

    const bassGain = this.ctx.createGain();
    bassGain.gain.setValueAtTime(Math.min(0.64, 0.42 * heavyScale), now);
    bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.76);

    bass.connect(bassGain);
    bassGain.connect(out);
    bass.start(now);
    bass.stop(now + 0.8);

    // 2. Bough-crushing branch snaps right on impact (crown hitting the ground!)
    for (let i = 0; i < 4; i++) {
      const t = now + 0.015 + i * 0.068 + Math.random() * 0.025;
      this.scheduleWoodCrack(
        t,
        (0.95 - i * 0.16) * Math.min(1.3, weightScale),
        ac.woodPitch * (0.95 + Math.random() * 0.35),
        ac.crackSharpness,
        i === 0 && ac.fiberStringiness > 0.6
      );
    }

    // 3. Crashing boughs & species-tuned foliage cushion settle
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1650 * ac.foliageBrightness, now);
    filter.frequency.exponentialRampToValueAtTime(220, now + 1.25);

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.38 * Math.min(1.35, weightScale), now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 1.35);

    src.connect(filter);
    filter.connect(nGain);
    nGain.connect(out);
    src.start(now);
    src.stop(now + 1.4);
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
    this.stopTreeFallSound();
    if (this.birdTimer !== null) clearTimeout(this.birdTimer);
    if (this.ctx) {
      this.ctx.close().catch(() => {});
    }
  }
}
