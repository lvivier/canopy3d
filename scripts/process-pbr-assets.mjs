#!/usr/bin/env node
/**
 * 1. Optimizes downloaded Poly Haven 2K CC0 JPG textures to lean WebP (2K + 1K diff)
 *    and cleans up bulky raw JPGs.
 * 2. Processes Step-3 generated specialty tiles (Sitka spruce, Arbutus, Ponderosa,
 *    Trembling Aspen, and freshly sawn end-grain) into delighted seamless albedo
 *    plus physically motivated OpenGL Normal + ARM (AO/Roughness/Metalness) WebP maps.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(process.cwd(), 'public', 'assets');
const TEX_ROOT = path.join(ROOT, 'textures');
const CURSOR_ASSETS = '/Users/luke/.cursor/projects/Users-luke-Projects-canopy3d/assets';

const POLYHAVEN_IDS = [
  'pine_bark',
  'japanese_cedar_bark',
  'tree_bark_03',
  'bark_willow',
  'bark_brown_01',
  'leaves_forest_ground',
  'grass_path_3',
  'brown_mud_leaves_01',
  'mossy_rock',
  'wood_planks',
  'gravel_road',
];

const CUSTOM_TILES = [
  { id: 'sitka_spruce_bark', src: 'sitka-spruce-bark.jpg', mode: 'fissured_bark', seamless: true },
  { id: 'arbutus_bark', src: 'arbutus-bark.jpg', mode: 'peeling_arbutus', seamless: true },
  { id: 'ponderosa_pine_bark', src: 'ponderosa-pine-bark.jpg', mode: 'fissured_bark', seamless: true },
  { id: 'aspen_bark', src: 'aspen-bark.jpg', mode: 'aspen_eye', seamless: true },
  { id: 'sawn_end_grain', src: 'sawn-end-grain.jpg', mode: 'end_grain', seamless: false },
];

function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Smoothly tile an RGB buffer using toroidal half-shift + raised-cosine edge blend */
function makeSeamlessRGB(data, w, h) {
  const out = new Uint8Array(data.length);
  const hw = w >> 1;
  const hh = h >> 1;

  for (let y = 0; y < h; y++) {
    // 0 at edges, 1 at center
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / h);
    for (let x = 0; x < w; x++) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / w);
      // Weight favoring original at center, shifted copy near seams
      const wOrig = clamp(Math.pow(wx * wy, 0.55), 0, 1);
      const sx = (x + hw) % w;
      const sy = (y + hh) % h;
      const i0 = (y * w + x) * 3;
      const i1 = (sy * w + sx) * 3;
      const wShift = 1 - wOrig;
      out[i0] = Math.round(data[i0] * wOrig + data[i1] * wShift);
      out[i0 + 1] = Math.round(data[i0 + 1] * wOrig + data[i1 + 1] * wShift);
      out[i0 + 2] = Math.round(data[i0 + 2] * wOrig + data[i1 + 2] * wShift);
    }
  }
  return out;
}

/** Separable box blur on single-channel float field (toroidal when seamless=true) */
function blurFloat(src, w, h, radius, seamless) {
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  const inv = 1 / (radius * 2 + 1);

  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = seamless ? (k + w) % w : clamp(k, 0, w - 1);
      sum += src[y * w + x];
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum * inv;
      const xAdd = seamless ? (x + radius + 1) % w : Math.min(w - 1, x + radius + 1);
      const xSub = seamless ? (x - radius + w) % w : Math.max(0, x - radius);
      sum += src[y * w + xAdd] - src[y * w + xSub];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const y = seamless ? (k + h) % h : clamp(k, 0, h - 1);
      sum += tmp[y * w + x];
    }
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * inv;
      const yAdd = seamless ? (y + radius + 1) % h : Math.min(h - 1, y + radius + 1);
      const ySub = seamless ? (y - radius + h) % h : Math.max(0, y - radius);
      sum += tmp[yAdd * w + x] - tmp[ySub * w + x];
    }
  }
  return dst;
}

/** Delight RGB by removing ultra-low-frequency lighting gradient while preserving local color */
function delightRGB(rgb, w, h, seamless, strength = 0.55) {
  const luma = new Float32Array(w * h);
  let mean = 0;
  for (let i = 0; i < w * h; i++) {
    const l = (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) / 255;
    luma[i] = l;
    mean += l;
  }
  mean /= w * h;

  const lowFreq = blurFloat(luma, w, h, Math.max(24, Math.round(w * 0.06)), seamless);
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < w * h; i++) {
    const gain = clamp(1 + (mean - lowFreq[i]) * strength * 1.4, 0.78, 1.25);
    out[i * 3] = Math.round(clamp(rgb[i * 3] * gain, 0, 255));
    out[i * 3 + 1] = Math.round(clamp(rgb[i * 3 + 1] * gain, 0, 255));
    out[i * 3 + 2] = Math.round(clamp(rgb[i * 3 + 2] * gain, 0, 255));
  }
  return out;
}

/** Build surface-aware Height, OpenGL Normal, and ARM (R=AO, G=Rough, B=Metal) from delighted RGB */
function extractPBR(rgb, w, h, mode, seamless) {
  const n = w * h;
  const luma = new Float32Array(n);
  const height = new Float32Array(n);
  const peelMask = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3] / 255;
    const g = rgb[i * 3 + 1] / 255;
    const b = rgb[i * 3 + 2] / 255;
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;

    if (mode === 'peeling_arbutus') {
      // Terracotta outer bark has strong R > G; chartreuse/ochre underbark has high G relative to R
      const outerScore = clamp(((r - g) - 0.06) * 5.2, 0, 1);
      peelMask[i] = outerScore;
    }
  }

  const blurSmall = blurFloat(luma, w, h, 2, seamless);
  const blurMed = blurFloat(luma, w, h, 7, seamless);
  const blurLarge = blurFloat(luma, w, h, 20, seamless);

  let normalStrength = 3.2;
  const arm = new Uint8Array(n * 3);

  if (mode === 'end_grain') {
    // Growth rings are FLAT color changes — only high-frequency saw kerf fibers & checks become relief!
    normalStrength = 1.15;
    for (let i = 0; i < n; i++) {
      const micro = luma[i] - blurSmall[i];
      const radialCrack = Math.min(0, luma[i] - blurMed[i]);
      height[i] = clamp(0.5 + micro * 1.4 + radialCrack * 0.9, 0, 1);
      const ao = clamp(0.92 + radialCrack * 1.2, 0.65, 1.0);
      const rough = clamp(0.76 + Math.abs(micro) * 1.6 - radialCrack * 0.35, 0.62, 0.92);
      arm[i * 3] = Math.round(ao * 255);
      arm[i * 3 + 1] = Math.round(rough * 255);
      arm[i * 3 + 2] = 0;
    }
  } else if (mode === 'peeling_arbutus') {
    const smoothOuter = blurFloat(peelMask, w, h, 2, seamless);
    const edgeAO = blurFloat(peelMask, w, h, 8, seamless);
    normalStrength = 3.0;
    for (let i = 0; i < n; i++) {
      const micro = (luma[i] - blurSmall[i]) * 0.35;
      // Outer terracotta plates sit raised above satin chartreuse inner bark
      height[i] = clamp(0.28 + smoothOuter[i] * 0.56 + micro, 0, 1);
      // Cavity AO right along the curled peel margin
      const curlEdge = Math.abs(smoothOuter[i] - edgeAO[i]);
      const ao = clamp(0.95 - curlEdge * 1.65 - (1 - smoothOuter[i]) * 0.08, 0.45, 1.0);
      // Fresh inner bark is satin smooth (~0.48); outer terracotta bark is slightly drier (~0.72)
      const rough = clamp(0.48 + smoothOuter[i] * 0.24 + Math.abs(micro) * 0.8, 0.4, 0.86);
      arm[i * 3] = Math.round(ao * 255);
      arm[i * 3 + 1] = Math.round(rough * 255);
      arm[i * 3 + 2] = 0;
    }
  } else if (mode === 'aspen_eye') {
    // Chalky white bark is mostly smooth; dark eye scars and horizontal lenticels are indented
    normalStrength = 2.6;
    for (let i = 0; i < n; i++) {
      const scarDepth = clamp((0.62 - luma[i]) * 1.6, 0, 1);
      const micro = (luma[i] - blurSmall[i]) * 0.45;
      height[i] = clamp(0.72 - scarDepth * 0.52 + micro, 0, 1);
      const ao = clamp(0.96 - scarDepth * 0.46, 0.45, 1.0);
      const rough = clamp(0.74 + scarDepth * 0.18 + Math.abs(micro) * 0.5, 0.65, 0.95);
      arm[i * 3] = Math.round(ao * 255);
      arm[i * 3 + 1] = Math.round(rough * 255);
      arm[i * 3 + 2] = 0;
    }
  } else {
    // Fissured / scaly conifer bark (Sitka Spruce, Ponderosa Pine):
    // Combine macro plate depth + medium flake structure + micro grit
    normalStrength = 4.2;
    for (let i = 0; i < n; i++) {
      const macroDepth = clamp((blurLarge[i] - 0.12) * 1.15, 0, 1);
      const plateDetail = clamp(0.5 + (blurMed[i] - blurLarge[i]) * 1.7, 0, 1);
      const micro = (luma[i] - blurSmall[i]) * 0.7;
      height[i] = clamp(macroDepth * 0.45 + plateDetail * 0.42 + luma[i] * 0.13 + micro, 0, 1);
      const cavity = clamp(1 - (height[i] * 1.15), 0, 1);
      const ao = clamp(0.98 - cavity * 0.54, 0.38, 1.0);
      const rough = clamp(0.80 + cavity * 0.14 + Math.abs(micro) * 0.45, 0.74, 0.96);
      arm[i * 3] = Math.round(ao * 255);
      arm[i * 3 + 1] = Math.round(rough * 255);
      arm[i * 3 + 2] = 0;
    }
  }

  // Sobel 3x3 OpenGL Tangent-Space Normal Map (+X right, +Y up, +Z out)
  const nor = new Uint8Array(n * 3);
  const sampleH = (x, y) => {
    const sx = seamless ? (x + w) % w : clamp(x, 0, w - 1);
    const sy = seamless ? (y + h) % h : clamp(y, 0, h - 1);
    return height[sy * w + sx];
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = sampleH(x - 1, y - 1);
      const t = sampleH(x, y - 1);
      const tr = sampleH(x + 1, y - 1);
      const l = sampleH(x - 1, y);
      const r = sampleH(x + 1, y);
      const bl = sampleH(x - 1, y + 1);
      const b = sampleH(x, y + 1);
      const br = sampleH(x + 1, y + 1);

      const dX = (tr + 2 * r + br) - (tl + 2 * l + bl);
      // Image Y grows downward, OpenGL normal +Y points upward -> flip sign
      const dY = (tl + 2 * t + tr) - (bl + 2 * b + br);

      let nx = -dX * normalStrength;
      let ny = -dY * normalStrength;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const idx = (y * w + x) * 3;
      nor[idx] = Math.round(clamp(nx * 0.5 + 0.5, 0, 1) * 255);
      nor[idx + 1] = Math.round(clamp(ny * 0.5 + 0.5, 0, 1) * 255);
      nor[idx + 2] = Math.round(clamp(nz * 0.5 + 0.5, 0, 1) * 255);
    }
  }

  return { nor, arm };
}

async function optimizePolyHaven() {
  const entries = {};
  let totalBytes = 0;

  for (const id of POLYHAVEN_IDS) {
    const dir = path.join(TEX_ROOT, id);
    const diffJpg = path.join(dir, 'diff.jpg');
    const norJpg = path.join(dir, 'nor.jpg');
    const armJpg = path.join(dir, 'arm.jpg');

    const diffWebp = path.join(dir, 'diff.webp');
    const diff1kWebp = path.join(dir, 'diff_1k.webp');
    const norWebp = path.join(dir, 'nor.webp');
    const armWebp = path.join(dir, 'arm.webp');

    // Convert 2K diffuse -> 2K WebP (q=76) + 1K WebP (q=74)
    try {
      await fs.access(diffJpg);
      await sharp(diffJpg).resize(2048, 2048, { fit: 'inside' }).webp({ quality: 76 }).toFile(diffWebp);
      await sharp(diffJpg).resize(1024, 1024, { fit: 'inside' }).webp({ quality: 74 }).toFile(diff1kWebp);
      await fs.unlink(diffJpg);
    } catch {
      // already converted
    }

    // Convert 2K OpenGL normal -> 1536px WebP (q=82) — crisp relief, huge size savings!
    try {
      await fs.access(norJpg);
      await sharp(norJpg).resize(1536, 1536, { fit: 'inside' }).webp({ quality: 82 }).toFile(norWebp);
      await fs.unlink(norJpg);
    } catch {
      // already converted
    }

    // Convert ARM (AO/Rough/Metal) -> 1024px WebP (q=78)
    try {
      await fs.access(armJpg);
      await sharp(armJpg).resize(1024, 1024, { fit: 'inside' }).webp({ quality: 78 }).toFile(armWebp);
      await fs.unlink(armJpg);
    } catch {
      // already converted
    }

    const sizes = await Promise.all(
      [diffWebp, diff1kWebp, norWebp, armWebp].map(async (f) => (await fs.stat(f)).size)
    );
    const sum = sizes.reduce((a, b) => a + b, 0);
    totalBytes += sum;
    console.log(`CC0 ${id}: ${(sum / 1024).toFixed(0)} KB total (diff2k=${(sizes[0]/1024).toFixed(0)}K, diff1k=${(sizes[1]/1024).toFixed(0)}K, nor=${(sizes[2]/1024).toFixed(0)}K, arm=${(sizes[3]/1024).toFixed(0)}K)`);

    entries[id] = {
      diff: `assets/textures/${id}/diff.webp`,
      diff1k: `assets/textures/${id}/diff_1k.webp`,
      nor: `assets/textures/${id}/nor.webp`,
      arm: `assets/textures/${id}/arm.webp`,
      source: 'Poly Haven (CC0)',
    };
  }

  return { entries, totalBytes };
}

async function processCustomTiles() {
  const entries = {};
  let totalBytes = 0;

  for (const tile of CUSTOM_TILES) {
    const srcPath = path.join(CURSOR_ASSETS, tile.src);
    const outDir = path.join(TEX_ROOT, tile.id);
    await fs.mkdir(outDir, { recursive: true });

    const targetSize = 1024;
    const { data, info } = await sharp(srcPath)
      .resize(targetSize, targetSize, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let rgb = new Uint8Array(data);
    if (tile.seamless) {
      rgb = makeSeamlessRGB(rgb, info.width, info.height);
    }
    const delighted = delightRGB(rgb, info.width, info.height, tile.seamless, tile.mode === 'end_grain' ? 0.3 : 0.48);
    const { nor, arm } = extractPBR(delighted, info.width, info.height, tile.mode, tile.seamless);

    const diffWebp = path.join(outDir, 'diff.webp');
    const diff1kWebp = path.join(outDir, 'diff_1k.webp');
    const norWebp = path.join(outDir, 'nor.webp');
    const armWebp = path.join(outDir, 'arm.webp');

    await sharp(Buffer.from(delighted), { raw: { width: info.width, height: info.height, channels: 3 } })
      .webp({ quality: 82 })
      .toFile(diffWebp);
    await sharp(Buffer.from(delighted), { raw: { width: info.width, height: info.height, channels: 3 } })
      .resize(512, 512)
      .webp({ quality: 76 })
      .toFile(diff1kWebp);
    await sharp(Buffer.from(nor), { raw: { width: info.width, height: info.height, channels: 3 } })
      .webp({ quality: 86 })
      .toFile(norWebp);
    await sharp(Buffer.from(arm), { raw: { width: info.width, height: info.height, channels: 3 } })
      .webp({ quality: 80 })
      .toFile(armWebp);

    const sizes = await Promise.all(
      [diffWebp, diff1kWebp, norWebp, armWebp].map(async (f) => (await fs.stat(f)).size)
    );
    const sum = sizes.reduce((a, b) => a + b, 0);
    totalBytes += sum;
    console.log(`Custom PBR ${tile.id}: ${(sum / 1024).toFixed(0)} KB total`);

    entries[tile.id] = {
      diff: `assets/textures/${tile.id}/diff.webp`,
      diff1k: `assets/textures/${tile.id}/diff_1k.webp`,
      nor: `assets/textures/${tile.id}/nor.webp`,
      arm: `assets/textures/${tile.id}/arm.webp`,
      source: 'Generated + Delighted PBR Extractor',
    };
  }

  return { entries, totalBytes };
}

async function main() {
  const ph = await optimizePolyHaven();
  const custom = await processCustomTiles();

  const manifestPath = path.join(ROOT, 'manifest.json');
  const existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const updated = {
    ...existing,
    textures: { ...ph.entries, ...custom.entries },
  };
  await fs.writeFile(manifestPath, JSON.stringify(updated, null, 2));

  // Measure HDRI size too
  const hdriDir = path.join(ROOT, 'hdri');
  const hdriFiles = await fs.readdir(hdriDir);
  let hdriBytes = 0;
  for (const f of hdriFiles) {
    hdriBytes += (await fs.stat(path.join(hdriDir, f))).size;
  }

  const grandTotal = ph.totalBytes + custom.totalBytes + hdriBytes;
  console.log(`\nAsset bundle summary:`);
  console.log(`  CC0 Poly Haven WebP textures: ${(ph.totalBytes / 1048576).toFixed(2)} MB`);
  console.log(`  Custom Step-3 WebP textures:  ${(custom.totalBytes / 1048576).toFixed(2)} MB`);
  console.log(`  CC0 Poly Haven 1K HDRIs:      ${(hdriBytes / 1048576).toFixed(2)} MB`);
  console.log(`  GRAND TOTAL in public/assets: ${(grandTotal / 1048576).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
