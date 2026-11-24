import * as THREE from 'three';
import { SpeciesId, SpeciesSpec } from '../types';
import { PNW_SPECIES } from '../data/species';

function createSeededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export interface BarkTextureSet {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  endGrainMap: THREE.CanvasTexture;
}

class TextureCache {
  private barkCache = new Map<SpeciesId, BarkTextureSet>();
  private terrainCache = new Map<string, THREE.CanvasTexture>();
  private woodPlankCache = new Map<string, THREE.CanvasTexture>();

  public getBarkTextures(speciesId: SpeciesId): BarkTextureSet {
    const existing = this.barkCache.get(speciesId);
    if (existing) return existing;

    const spec = PNW_SPECIES[speciesId];
    const set = this.generateBarkSet(spec);
    this.barkCache.set(speciesId, set);
    return set;
  }

  private generateBarkSet(spec: SpeciesSpec): BarkTextureSet {
    const size = 512;
    const diffCanvas = document.createElement('canvas');
    diffCanvas.width = size;
    diffCanvas.height = size;
    const ctx = diffCanvas.getContext('2d')!;

    const bumpCanvas = document.createElement('canvas');
    bumpCanvas.width = size;
    bumpCanvas.height = size;
    const bctx = bumpCanvas.getContext('2d')!;

    const rand = createSeededRandom(spec.id.split('').reduce((a, c) => a + c.charCodeAt(0) * 31, 7));

    // Base fill
    ctx.fillStyle = spec.barkPrimary;
    ctx.fillRect(0, 0, size, size);
    bctx.fillStyle = '#808080';
    bctx.fillRect(0, 0, size, size);

    if (spec.barkStyle === 'furrowed') {
      // Douglas Fir: deep dark vertical furrows & chunky reddish ridges
      for (let i = 0; i < 95; i++) {
        const x = rand() * size;
        const w = 5 + rand() * 14;
        ctx.fillStyle = rand() > 0.45 ? spec.barkSecondary : '#23150e';
        bctx.fillStyle = '#282828';
        ctx.beginPath();
        bctx.beginPath();
        let cx = x;
        ctx.moveTo(cx, 0);
        bctx.moveTo(cx, 0);
        for (let y = 0; y <= size; y += 32) {
          cx += (rand() - 0.5) * 7;
          ctx.lineTo(cx, y);
          bctx.lineTo(cx, y);
        }
        ctx.lineWidth = w;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.stroke();
        bctx.lineWidth = w;
        bctx.strokeStyle = '#262626';
        bctx.stroke();
      }
      // Subtle highlight ridges
      for (let i = 0; i < 120; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const h = 30 + rand() * 90;
        const w = 4 + rand() * 9;
        ctx.fillStyle = 'rgba(130, 88, 62, 0.28)';
        ctx.fillRect(x, y, w, h);
        bctx.fillStyle = 'rgba(235, 235, 235, 0.35)';
        bctx.fillRect(x, y, w, h);
      }
    } else if (spec.barkStyle === 'fibrous') {
      // Western Red Cedar: long stringy cinnamon-red vertical fibers
      for (let i = 0; i < 240; i++) {
        const x = rand() * size;
        const w = 2 + rand() * 6;
        ctx.strokeStyle = rand() > 0.5 ? spec.barkSecondary : '#8a5238';
        ctx.globalAlpha = 0.45 + rand() * 0.45;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        let cx = x;
        for (let y = 0; y <= size; y += 64) {
          cx += (rand() - 0.5) * 4;
          ctx.lineTo(cx, y);
        }
        ctx.stroke();

        bctx.strokeStyle = rand() > 0.5 ? '#c8c8c8' : '#404040';
        bctx.lineWidth = w;
        bctx.beginPath();
        bctx.moveTo(x, 0);
        bctx.lineTo(cx, size);
        bctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (spec.barkStyle === 'scaly') {
      // Sitka Spruce: rounded overlapping purplish-gray bark scales
      for (let i = 0; i < 320; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const rx = 10 + rand() * 18;
        const ry = 14 + rand() * 26;
        ctx.fillStyle = rand() > 0.5 ? spec.barkSecondary : '#685c5e';
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, (rand() - 0.5) * 0.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(25, 20, 22, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        bctx.fillStyle = rand() > 0.5 ? '#b4b4b4' : '#555555';
        bctx.beginPath();
        bctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        bctx.fill();
      }
    } else if (spec.barkStyle === 'mossy') {
      // Bigleaf Maple: furrowed gray-brown bark with lush emerald-olive moss pillows
      for (let i = 0; i < 110; i++) {
        const x = rand() * size;
        ctx.strokeStyle = '#3c392f';
        ctx.lineWidth = 3 + rand() * 7;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + (rand() - 0.5) * 18, size);
        ctx.stroke();
      }
      // Moss patches
      for (let i = 0; i < 85; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const rx = 14 + rand() * 34;
        const ry = 18 + rand() * 48;
        const grad = ctx.createRadialGradient(x, y, 2, x, y, Math.max(rx, ry));
        grad.addColorStop(0, 'rgba(78, 118, 46, 0.82)');
        grad.addColorStop(0.65, 'rgba(58, 92, 37, 0.55)');
        grad.addColorStop(1, 'rgba(58, 92, 37, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();

        bctx.fillStyle = 'rgba(210, 210, 210, 0.45)';
        bctx.beginPath();
        bctx.ellipse(x, y, rx * 0.7, ry * 0.7, 0, 0, Math.PI * 2);
        bctx.fill();
      }
    } else if (spec.barkStyle === 'smooth_lichen') {
      // Red Alder: pale gray smooth bark with horizontal lenticels & pale crustose lichen blotches
      for (let i = 0; i < 160; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const r = 10 + rand() * 30;
        ctx.fillStyle = rand() > 0.4 ? 'rgba(170, 178, 166, 0.38)' : 'rgba(92, 102, 92, 0.35)';
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.6 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      // Horizontal dark lenticel dashes
      for (let i = 0; i < 200; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 8 + rand() * 20;
        ctx.fillStyle = 'rgba(54, 56, 52, 0.5)';
        ctx.fillRect(x, y, w, 2);
        bctx.fillStyle = '#505050';
        bctx.fillRect(x, y, w, 2);
      }
    } else {
      // Western Hemlock: russet-brown flat plates & narrow dark grooves
      for (let i = 0; i < 160; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 10 + rand() * 24;
        const h = 36 + rand() * 72;
        ctx.fillStyle = rand() > 0.5 ? spec.barkSecondary : '#6b473a';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(28, 16, 12, 0.65)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        bctx.fillStyle = rand() > 0.5 ? '#c0c0c0' : '#4a4a4a';
        bctx.fillRect(x, y, w, h);
      }
    }

    // Subtle mossy base tint & fine grain
    for (let i = 0; i < 1400; i++) {
      const x = rand() * size;
      const y = rand() * size;
      ctx.fillStyle = rand() > 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(x, y, 2, 3);
    }

    const map = new THREE.CanvasTexture(diffCanvas);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.SRGBColorSpace;
    map.repeat.set(2, 5);

    const bumpMap = new THREE.CanvasTexture(bumpCanvas);
    bumpMap.wrapS = THREE.RepeatWrapping;
    bumpMap.wrapT = THREE.RepeatWrapping;
    bumpMap.repeat.set(2, 5);

    const endGrainMap = this.generateEndGrainTexture(spec);

    return { map, bumpMap, endGrainMap };
  }

  private generateEndGrainTexture(spec: SpeciesSpec): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cx = size / 2;
    const cy = size / 2;

    // Outer bark rim
    ctx.fillStyle = spec.barkSecondary;
    ctx.fillRect(0, 0, size, size);

    // Sapwood ring
    ctx.fillStyle = spec.sapwoodColor;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.47, 0, Math.PI * 2);
    ctx.fill();

    // Heartwood core gradient
    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, size * 0.36);
    grad.addColorStop(0, spec.heartwoodColor);
    grad.addColorStop(0.82, spec.heartwoodColor);
    grad.addColorStop(1, spec.sapwoodColor);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.37, 0, Math.PI * 2);
    ctx.fill();

    // Growth rings
    const ringCount = 22;
    for (let i = 1; i <= ringCount; i++) {
      const r = (i / ringCount) * size * 0.45;
      ctx.strokeStyle = i < 15 ? 'rgba(70, 38, 18, 0.32)' : 'rgba(90, 62, 34, 0.22)';
      ctx.lineWidth = i % 3 === 0 ? 1.8 : 1.0;
      ctx.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.22) {
        const wobble = Math.sin(a * 3 + i * 0.7) * 1.4 + Math.cos(a * 5 - i) * 0.8;
        const px = cx + Math.cos(a) * (r + wobble);
        const py = cy + Math.sin(a) * (r + wobble);
        if (a === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Subtle radial checking lines
    ctx.strokeStyle = 'rgba(55, 30, 15, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * size * 0.28, cy + Math.sin(a) * size * 0.28);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  public getTerrainTexture(style: 'homestead' | 'creek' | 'ridge' | 'bluff'): THREE.CanvasTexture {
    const cached = this.terrainCache.get(style);
    if (cached) return cached;

    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const rand = createSeededRandom(style.length * 997 + 42);

    const palettes = {
      homestead: { base: '#4a7035', mid: '#5d8741', dark: '#365527', duff: '#6b5a3d' },
      creek: { base: '#406a36', mid: '#538244', dark: '#2e5128', duff: '#5c523b' },
      ridge: { base: '#425e2f', mid: '#55733b', dark: '#304723', duff: '#675034' },
      bluff: { base: '#51693b', mid: '#657d48', dark: '#3c502b', duff: '#705e42' },
    };
    const p = palettes[style];

    ctx.fillStyle = p.base;
    ctx.fillRect(0, 0, size, size);

    // Organic mossy / meadow patches
    for (let i = 0; i < 240; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 12 + rand() * 44;
      const color = rand() > 0.65 ? p.mid : rand() > 0.3 ? p.dark : p.duff;
      const grad = ctx.createRadialGradient(x, y, 2, x, y, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Fine grass blades & cedar needle duff speckles
    for (let i = 0; i < 3200; i++) {
      const x = rand() * size;
      const y = rand() * size;
      ctx.fillStyle =
        rand() > 0.65
          ? 'rgba(110, 148, 65, 0.24)'
          : rand() > 0.35
            ? 'rgba(26, 40, 18, 0.24)'
            : 'rgba(105, 82, 52, 0.22)';
      ctx.fillRect(x, y, 2, 4);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(16, 16);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.terrainCache.set(style, tex);
    return tex;
  }

  public getWoodPlankTexture(baseColor: string, plankCount = 10): THREE.CanvasTexture {
    const key = `${baseColor}-${plankCount}`;
    const cached = this.woodPlankCache.get(key);
    if (cached) return cached;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const rand = createSeededRandom(key.length * 131 + 7);

    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, size, size);

    const h = size / plankCount;
    for (let i = 0; i < plankCount; i++) {
      const y = i * h;
      const shade = (rand() - 0.5) * 26;
      ctx.fillStyle = shade > 0 ? `rgba(255,240,210,${shade / 260})` : `rgba(0,0,0,${-shade / 240})`;
      ctx.fillRect(0, y, size, h);

      // Grain lines
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      for (let g = 0; g < 3; g++) {
        ctx.beginPath();
        ctx.moveTo(0, y + (g + 0.5) * (h / 3));
        ctx.lineTo(size, y + (g + 0.5) * (h / 3) + (rand() - 0.5) * 3);
        ctx.stroke();
      }

      // Plank seam
      ctx.fillStyle = 'rgba(18, 12, 8, 0.55)';
      ctx.fillRect(0, y, size, 1.5);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.woodPlankCache.set(key, tex);
    return tex;
  }

  public getGravelTexture(): THREE.CanvasTexture {
    const key = 'gravel_driveway';
    const cached = this.terrainCache.get(key);
    if (cached) return cached;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const rand = createSeededRandom(4409);

    ctx.fillStyle = '#999284';
    ctx.fillRect(0, 0, size, size);

    // Subtle tire track compression bands
    ctx.fillStyle = 'rgba(72, 66, 56, 0.18)';
    ctx.fillRect(size * 0.2, 0, size * 0.18, size);
    ctx.fillRect(size * 0.62, 0, size * 0.18, size);

    // River-stone pebbles
    for (let i = 0; i < 2400; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 1.2 + rand() * 3.2;
      const v = 105 + Math.floor(rand() * 88);
      ctx.fillStyle = `rgb(${v + 6}, ${v + 2}, ${v - 8})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.65 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    // Grassy mossy edges along left & right borders
    const leftGrad = ctx.createLinearGradient(0, 0, size * 0.12, 0);
    leftGrad.addColorStop(0, '#4a6e34');
    leftGrad.addColorStop(1, 'rgba(74, 110, 52, 0)');
    ctx.fillStyle = leftGrad;
    ctx.fillRect(0, 0, size * 0.12, size);

    const rightGrad = ctx.createLinearGradient(size, 0, size * 0.88, 0);
    rightGrad.addColorStop(0, '#4a6e34');
    rightGrad.addColorStop(1, 'rgba(74, 110, 52, 0)');
    ctx.fillStyle = rightGrad;
    ctx.fillRect(size * 0.88, 0, size * 0.12, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 6);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.terrainCache.set(key, tex);
    return tex;
  }
}

export const textureCache = new TextureCache();
