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
    } else if (spec.barkStyle === 'yellow_cedar_flaky') {
      // Yellow Cedar: pale ashy silver-gray shredding vertical strips over warm tan inner fissures
      for (let i = 0; i < 160; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 4 + rand() * 11;
        const h = 48 + rand() * 110;
        ctx.fillStyle = rand() > 0.3 ? '#b5b1a8' : '#969188';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(115, 86, 54, 0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        bctx.fillStyle = rand() > 0.35 ? '#d4d4d4' : '#585858';
        bctx.fillRect(x, y, w, h);
      }
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
    } else if (spec.barkStyle === 'smooth_bronze') {
      // Japanese Maple: smooth silvery-bronze bark with delicate pale vertical striations
      for (let i = 0; i < 150; i++) {
        const x = rand() * size;
        const w = 2 + rand() * 5;
        ctx.fillStyle = rand() > 0.5 ? 'rgba(155, 134, 126, 0.25)' : 'rgba(62, 46, 46, 0.28)';
        ctx.fillRect(x, 0, w, size);
        bctx.fillStyle = rand() > 0.5 ? '#909090' : '#707070';
        bctx.fillRect(x, 0, w, size);
      }
      for (let i = 0; i < 95; i++) {
        const x = rand() * size;
        const y = rand() * size;
        ctx.fillStyle = 'rgba(188, 174, 166, 0.26)';
        ctx.fillRect(x, y, 6 + rand() * 14, 1.5);
      }
    } else if (spec.barkStyle === 'white_diamond') {
      // White Poplar: chalky pale silver-white bark with dark charcoal diamond-shaped lenticels
      for (let i = 0; i < 90; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const rx = 18 + rand() * 44;
        const ry = 22 + rand() * 52;
        ctx.fillStyle = rand() > 0.45 ? 'rgba(232, 236, 228, 0.45)' : 'rgba(176, 184, 174, 0.32)';
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // Signature dark diamond lenticel scars
      for (let i = 0; i < 145; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const dw = 6 + rand() * 14;
        const dh = 3 + rand() * 6;
        ctx.fillStyle = rand() > 0.35 ? 'rgba(42, 44, 40, 0.78)' : 'rgba(68, 70, 65, 0.65)';
        ctx.beginPath();
        ctx.moveTo(x - dw, y);
        ctx.lineTo(x, y - dh);
        ctx.lineTo(x + dw, y);
        ctx.lineTo(x, y + dh);
        ctx.closePath();
        ctx.fill();

        bctx.fillStyle = '#383838';
        bctx.beginPath();
        bctx.moveTo(x - dw, y);
        bctx.lineTo(x, y - dh);
        bctx.lineTo(x + dw, y);
        bctx.lineTo(x, y + dh);
        bctx.closePath();
        bctx.fill();
      }
    } else if (spec.barkStyle === 'peeling_terracotta') {
      // Pacific Arbutus: smooth cinnamon-terracotta bark with chartreuse-ochre freshly peeled underbark & curling flakes
      for (let i = 0; i < 48; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const rx = 20 + rand() * 54;
        const ry = 32 + rand() * 88;
        ctx.fillStyle =
          rand() > 0.62
            ? 'rgba(202, 186, 122, 0.72)' // freshly peeled chartreuse-ochre satin underbark
            : rand() > 0.35
              ? 'rgba(196, 98, 60, 0.55)'
              : 'rgba(130, 44, 28, 0.52)';
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, (rand() - 0.5) * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
      // Thin curled papery cinnamon bark edges
      for (let i = 0; i < 85; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const h = 24 + rand() * 68;
        ctx.strokeStyle = rand() > 0.5 ? 'rgba(92, 28, 16, 0.68)' : 'rgba(222, 134, 88, 0.5)';
        ctx.lineWidth = 2 + rand() * 3.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + (rand() - 0.5) * 26, y + h * 0.5, x + (rand() - 0.5) * 14, y + h);
        ctx.stroke();

        bctx.strokeStyle = '#c8c8c8';
        bctx.lineWidth = 2;
        bctx.beginPath();
        bctx.moveTo(x, y);
        bctx.lineTo(x + (rand() - 0.5) * 12, y + h);
        bctx.stroke();
      }
    } else if (spec.barkStyle === 'pale_checkered') {
      // Garry Oak: pale ash-gray bark broken into blocky checkered scales & subtle pale lichen
      for (let i = 0; i < 190; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 14 + rand() * 24;
        const h = 18 + rand() * 34;
        ctx.fillStyle = rand() > 0.45 ? '#9c998e' : spec.barkSecondary;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(46, 44, 38, 0.72)';
        ctx.lineWidth = 2.2;
        ctx.strokeRect(x, y, w, h);

        bctx.fillStyle = rand() > 0.5 ? '#c6c6c6' : '#4e4e4e';
        bctx.fillRect(x, y, w, h);
      }
      // Subtle pale coastal oak lichen patches
      for (let i = 0; i < 55; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const r = 10 + rand() * 22;
        ctx.fillStyle = 'rgba(154, 174, 138, 0.34)';
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.75, rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (spec.barkStyle === 'redwood_fluted' || spec.barkStyle === 'sequoia_fluted') {
      // California Redwood / Giant Sequoia: thick, deeply fluted spongy cinnamon-terracotta ridges
      const isSeq = spec.barkStyle === 'sequoia_fluted';
      for (let i = 0; i < (isSeq ? 95 : 115); i++) {
        const x = rand() * size;
        const w = (isSeq ? 10 : 6) + rand() * (isSeq ? 20 : 14);
        ctx.strokeStyle = rand() > 0.45 ? spec.barkSecondary : isSeq ? '#4f1b0a' : '#3a120b';
        ctx.lineWidth = w;
        ctx.beginPath();
        let cx = x;
        ctx.moveTo(cx, 0);
        for (let y = 0; y <= size; y += 36) {
          cx += (rand() - 0.5) * 4.5;
          ctx.lineTo(cx, y);
        }
        ctx.stroke();

        bctx.strokeStyle = '#242424';
        bctx.lineWidth = w;
        bctx.beginPath();
        bctx.moveTo(x, 0);
        bctx.lineTo(cx, size);
        bctx.stroke();
      }
      // Rich fibrous rust-red / cinnamon-orange highlight ribs
      for (let i = 0; i < 160; i++) {
        const x = rand() * size;
        const w = (isSeq ? 5 : 3) + rand() * (isSeq ? 11 : 7);
        ctx.fillStyle = isSeq
          ? rand() > 0.5
            ? 'rgba(210, 102, 52, 0.42)'
            : 'rgba(178, 76, 36, 0.36)'
          : rand() > 0.5
            ? 'rgba(164, 72, 46, 0.38)'
            : 'rgba(132, 52, 34, 0.32)';
        ctx.fillRect(x, 0, w, size);
        bctx.fillStyle = 'rgba(235, 235, 235, 0.35)';
        bctx.fillRect(x, 0, w, size);
      }
    } else if (spec.barkStyle === 'peeling_eucalyptus') {
      // Blue Gum Eucalyptus: long vertical ribbons of cream, buff, and blue-gray peeling bark
      for (let i = 0; i < 95; i++) {
        const x = rand() * size;
        const w = 10 + rand() * 28;
        const palette = [
          'rgba(222, 215, 196, 0.72)', // creamy smooth inner bark
          'rgba(146, 160, 162, 0.62)', // blue-slate coastal hue
          'rgba(186, 174, 152, 0.58)', // warm tan-buff
          'rgba(104, 98, 86, 0.65)',   // outer gray shedding ribbon
        ];
        ctx.fillStyle = palette[Math.floor(rand() * palette.length)];
        ctx.beginPath();
        let cx = x;
        ctx.moveTo(cx, 0);
        for (let y = 0; y <= size; y += 48) {
          cx += (rand() - 0.5) * 8;
          ctx.lineTo(cx, y);
        }
        ctx.lineTo(cx + w, size);
        ctx.lineTo(x + w, 0);
        ctx.closePath();
        ctx.fill();

        bctx.strokeStyle = rand() > 0.5 ? '#c4c4c4' : '#525252';
        bctx.lineWidth = 2.5;
        bctx.beginPath();
        bctx.moveTo(x, 0);
        bctx.lineTo(cx, size);
        bctx.stroke();
      }
    } else if (spec.barkStyle === 'ponderosa_puzzle') {
      // Ponderosa Pine: large chunky cinnamon-orange jigsaw plates separated by deep charcoal fissures
      for (let i = 0; i < 115; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 22 + rand() * 38;
        const h = 42 + rand() * 88;
        ctx.fillStyle =
          rand() > 0.55
            ? '#b86c3f'
            : rand() > 0.28
              ? '#9a5430'
              : '#c9814c';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w * (0.85 + rand() * 0.25), y + (rand() - 0.5) * 14);
        ctx.lineTo(x + w + (rand() - 0.5) * 14, y + h);
        ctx.lineTo(x + (rand() - 0.5) * 12, y + h * (0.9 + rand() * 0.18));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(34, 19, 13, 0.85)';
        ctx.lineWidth = 4.5 + rand() * 3.5;
        ctx.stroke();

        bctx.fillStyle = '#cfcfcf';
        bctx.fillRect(x, y, w, h);
        bctx.strokeStyle = '#1e1e1e';
        bctx.lineWidth = 5;
        bctx.strokeRect(x, y, w, h);
      }
    } else if (spec.barkStyle === 'larch_flaky') {
      // Western Larch: deep reddish-cinnamon furrowed flaky bark ridges
      for (let i = 0; i < 110; i++) {
        const x = rand() * size;
        const w = 5 + rand() * 11;
        ctx.strokeStyle = rand() > 0.45 ? spec.barkSecondary : '#2d1810';
        ctx.lineWidth = w;
        ctx.beginPath();
        let cx = x;
        ctx.moveTo(cx, 0);
        for (let y = 0; y <= size; y += 36) {
          cx += (rand() - 0.5) * 8;
          ctx.lineTo(cx, y);
        }
        ctx.stroke();
        bctx.strokeStyle = '#262626';
        bctx.lineWidth = w;
        bctx.beginPath();
        bctx.moveTo(x, 0);
        bctx.lineTo(cx, size);
        bctx.stroke();
      }
      for (let i = 0; i < 180; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 10 + rand() * 20;
        const h = 24 + rand() * 54;
        ctx.fillStyle = rand() > 0.5 ? 'rgba(156, 86, 56, 0.52)' : 'rgba(122, 62, 42, 0.48)';
        ctx.fillRect(x, y, w, h);
        bctx.fillStyle = 'rgba(218, 218, 218, 0.4)';
        bctx.fillRect(x, y, w, h);
      }
    } else if (spec.barkStyle === 'white_pine_checkered') {
      // Western White Pine: silvery-gray bark divided into neat small rectangular checkered plates
      for (let i = 0; i < 240; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 12 + rand() * 18;
        const h = 14 + rand() * 22;
        ctx.fillStyle = rand() > 0.45 ? '#878986' : '#656764';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(42, 43, 41, 0.72)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        bctx.fillStyle = rand() > 0.5 ? '#c0c0c0' : '#565656';
        bctx.fillRect(x, y, w, h);
      }
    } else if (spec.barkStyle === 'cherry_lenticel') {
      // Chokecherry: smooth dark mahogany-brown bark with crisp pale horizontal lenticel stripes
      for (let i = 0; i < 120; i++) {
        const x = rand() * size;
        const w = 3 + rand() * 8;
        ctx.fillStyle = rand() > 0.5 ? 'rgba(94, 58, 48, 0.34)' : 'rgba(34, 20, 18, 0.36)';
        ctx.fillRect(x, 0, w, size);
      }
      for (let i = 0; i < 260; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 8 + rand() * 24;
        ctx.fillStyle = rand() > 0.4 ? 'rgba(212, 182, 148, 0.65)' : 'rgba(176, 138, 108, 0.52)';
        ctx.fillRect(x, y, w, 2.2);
        bctx.fillStyle = '#c4c4c4';
        bctx.fillRect(x, y, w, 2.2);
      }
    } else if (spec.barkStyle === 'aspen_eye') {
      // Trembling Aspen: luminous chalk-white smooth bark with dark curved horizontal eye knots
      for (let i = 0; i < 80; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const rx = 20 + rand() * 48;
        const ry = 26 + rand() * 58;
        ctx.fillStyle = rand() > 0.4 ? 'rgba(244, 245, 238, 0.55)' : 'rgba(198, 208, 190, 0.32)';
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // Signature dark horizontal eye scars & branch knots
      for (let i = 0; i < 125; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 8 + rand() * 22;
        const h = 2.5 + rand() * 4.5;
        ctx.fillStyle = 'rgba(38, 39, 34, 0.82)';
        ctx.beginPath();
        ctx.ellipse(x, y, w * 0.55, h, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(42, 43, 38, 0.72)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - w, y + 1);
        ctx.quadraticCurveTo(x, y - h * 1.4, x + w, y + 1);
        ctx.stroke();

        bctx.fillStyle = '#363636';
        bctx.beginPath();
        bctx.ellipse(x, y, w * 0.55, h, 0, 0, Math.PI * 2);
        bctx.fill();
      }
    } else if (spec.barkStyle === 'palm_fibrous') {
      // Windmill Palm: dense criss-crossing dark chocolate hemp fibers & overlapping leaf-base boots
      for (let i = 0; i < 420; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const len = 36 + rand() * 84;
        const diag = (rand() > 0.5 ? 1 : -1) * (0.45 + rand() * 0.55);
        ctx.strokeStyle =
          rand() > 0.68
            ? 'rgba(116, 86, 56, 0.52)'
            : rand() > 0.35
              ? 'rgba(62, 42, 27, 0.78)'
              : 'rgba(28, 18, 11, 0.86)';
        ctx.lineWidth = 1.5 + rand() * 3.0;
        ctx.beginPath();
        ctx.moveTo(x - len * 0.5, y - len * diag * 0.35);
        ctx.lineTo(x + len * 0.5, y + len * diag * 0.35);
        ctx.stroke();

        bctx.strokeStyle = rand() > 0.45 ? '#c6c6c6' : '#323232';
        bctx.lineWidth = 2.0;
        bctx.beginPath();
        bctx.moveTo(x - len * 0.5, y - len * diag * 0.35);
        bctx.lineTo(x + len * 0.5, y + len * diag * 0.35);
        bctx.stroke();
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

  public getTerrainTexture(
    style: 'homestead' | 'creek' | 'ridge' | 'bluff' | 'suburban' | 'headland' | 'kootenay'
  ): THREE.CanvasTexture {
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
      suburban: { base: '#4e833a', mid: '#639948', dark: '#3e6e2e', duff: '#5a7838' },
      headland: { base: '#6b7b3e', mid: '#88944c', dark: '#4d5c2d', duff: '#9b8d56' },
      kootenay: { base: '#8d8252', mid: '#aba068', dark: '#6d6b44', duff: '#a47d4e' },
    };
    const p = palettes[style];

    ctx.fillStyle = p.base;
    ctx.fillRect(0, 0, size, size);

    // Subtle mowed lawn bands for coastal town yards
    if (style === 'suburban') {
      const stripes = 8;
      const sh = size / stripes;
      for (let i = 0; i < stripes; i++) {
        ctx.fillStyle = i % 2 === 0 ? 'rgba(130, 185, 86, 0.13)' : 'rgba(34, 66, 26, 0.10)';
        ctx.fillRect(0, i * sh, size, sh);
      }
    }

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

    // Fine grass blades & cedar/pine needle duff speckles
    for (let i = 0; i < 3200; i++) {
      const x = rand() * size;
      const y = rand() * size;
      if (style === 'kootenay') {
        ctx.fillStyle =
          rand() > 0.55
            ? 'rgba(196, 178, 108, 0.30)'
            : rand() > 0.25
              ? 'rgba(116, 118, 76, 0.24)'
              : 'rgba(148, 106, 62, 0.24)';
      } else {
        ctx.fillStyle =
          rand() > 0.65
            ? 'rgba(110, 148, 65, 0.24)'
            : rand() > 0.35
              ? 'rgba(26, 40, 18, 0.24)'
              : 'rgba(105, 82, 52, 0.22)';
      }
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

  public getAsphaltTexture(): THREE.CanvasTexture {
    const key = 'coastal_asphalt';
    const cached = this.terrainCache.get(key);
    if (cached) return cached;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const rand = createSeededRandom(8817);

    ctx.fillStyle = '#474c52';
    ctx.fillRect(0, 0, size, size);

    // Fine coastal asphalt aggregate & subtle wear
    for (let i = 0; i < 2800; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const v = 56 + Math.floor(rand() * 44);
      ctx.fillStyle = `rgb(${v}, ${v + 2}, ${v + 5})`;
      ctx.fillRect(x, y, 2, 2);
    }

    // Curb edge shading
    ctx.fillStyle = 'rgba(25, 28, 32, 0.25)';
    ctx.fillRect(0, 0, size, 12);
    ctx.fillRect(0, size - 12, size, 12);

    // Dashed weathered yellow road centerline (horizontal along road length)
    ctx.fillStyle = '#dfb54b';
    ctx.fillRect(28, size * 0.5 - 4, 86, 8);
    ctx.fillRect(156, size * 0.5 - 4, 72, 8);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(10, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.terrainCache.set(key, tex);
    return tex;
  }
}

export const textureCache = new TextureCache();
