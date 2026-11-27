/**
 * Extracts zero-halo, mip-safe RGBA WebP + OpenGL Normal WebP botanical foliage sprigs
 * from chroma-keyed source images (cyan #00FFFF or magenta #FF00FF).
 *
 * Key AAA foliage steps:
 *  1. Analytical chroma-key alpha extraction + background un-premultiplication
 *  2. Edge spill suppression (zero cyan/magenta fringes)
 *  3. 18-pass alpha-edge RGB dilation so GPU mipmaps stay vibrant at all distances
 *  4. Sobel normal map extraction from leaf/needle luminance relief
 *
 * Usage: node scripts/process-foliage-sprigs.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const CURSOR_ASSETS = '/Users/luke/.cursor/projects/Users-luke-Projects-canopy3d/assets';
const OUT_ROOT = path.resolve('public/assets/foliage');

const SPRIGS = [
  { id: 'japanese_maple', src: 'sprig-japanese-maple.jpg', key: 'cyan', normalStrength: 1.35 },
  { id: 'douglas_fir', src: 'sprig-douglas-fir.jpg', key: 'magenta', normalStrength: 1.85 },
  { id: 'weeping_willow', src: 'sprig-weeping-willow.jpg', key: 'magenta', normalStrength: 1.45 },
  { id: 'deadwood', src: 'sprig-deadwood.jpg', key: 'cyan', normalStrength: 1.9 },
  { id: 'deadwood_conifer', src: 'sprig-deadwood-conifer.jpg', key: 'cyan', normalStrength: 1.9 },
  // Group 1 — Coastal Conifers
  { id: 'western_red_cedar', src: 'sprig-western-red-cedar.jpg', key: 'magenta', normalStrength: 1.55 },
  { id: 'yellow_cedar', src: 'sprig-yellow-cedar.jpg', key: 'magenta', normalStrength: 1.55 },
  { id: 'sitka_spruce', src: 'sprig-sitka-spruce.jpg', key: 'magenta', normalStrength: 1.85 },
  { id: 'western_hemlock', src: 'sprig-western-hemlock.jpg', key: 'magenta', normalStrength: 1.5 },
  { id: 'california_redwood', src: 'sprig-california-redwood.jpg', key: 'magenta', normalStrength: 1.75 },
  { id: 'giant_sequoia', src: 'sprig-giant-sequoia.jpg', key: 'magenta', normalStrength: 1.65 },
  // Group 2 — Interior & Alpine Conifers
  { id: 'ponderosa_pine', src: 'sprig-ponderosa-pine.jpg', key: 'magenta', normalStrength: 1.7 },
  { id: 'western_larch', src: 'sprig-western-larch.jpg', key: 'cyan', normalStrength: 1.45 },
  { id: 'blue_spruce', src: 'sprig-blue-spruce.jpg', key: 'magenta', normalStrength: 1.9 },
  { id: 'western_white_pine', src: 'sprig-western-white-pine.jpg', key: 'magenta', normalStrength: 1.55 },
  // Group 3 — PNW Native Hardwoods
  { id: 'bigleaf_maple', src: 'sprig-bigleaf-maple.jpg', key: 'magenta', normalStrength: 1.4 },
  { id: 'red_alder', src: 'sprig-red-alder.jpg', key: 'magenta', normalStrength: 1.45 },
  { id: 'garry_oak', src: 'sprig-garry-oak.jpg', key: 'magenta', normalStrength: 1.55 },
  { id: 'arbutus', src: 'sprig-arbutus.jpg', key: 'cyan', normalStrength: 1.5 },
  // Group 4 — Tall Broadleafs & Poplars
  { id: 'white_poplar', src: 'sprig-white-poplar.jpg', key: 'magenta', normalStrength: 1.35, preserveWhite: true },
  { id: 'trembling_aspen', src: 'sprig-trembling-aspen.jpg', key: 'cyan', normalStrength: 1.3 },
  { id: 'eucalyptus', src: 'sprig-eucalyptus.jpg', key: 'magenta', normalStrength: 1.4, preserveWhite: true },
  { id: 'chokecherry', src: 'sprig-chokecherry.jpg', key: 'magenta', normalStrength: 1.45, preserveWhite: true },
  { id: 'chokecherry_leaves', src: 'sprig-chokecherry-leaves.jpg', key: 'cyan', normalStrength: 1.4 },
  // Group 5 — Ornamental & Flowering Trees
  { id: 'lilac', src: 'sprig-lilac.jpg', key: 'cyan', normalStrength: 1.5 },
  { id: 'lilac_leaves', src: 'sprig-lilac-leaves.jpg', key: 'cyan', normalStrength: 1.45 },
  { id: 'smoke_tree', src: 'sprig-smoke-tree-plumes.jpg', key: 'green', softAlpha: true, normalStrength: 1.15 },
  { id: 'smoke_tree_leaves', src: 'sprig-smoke-tree-leaves.jpg', key: 'cyan', normalStrength: 1.35 },
  { id: 'rhododendron', src: 'sprig-rhododendron.jpg', key: 'cyan', normalStrength: 1.55 },
  { id: 'rhododendron_leaves', src: 'sprig-rhododendron-leaves.jpg', key: 'cyan', normalStrength: 1.5 },
  { id: 'windmill_palm', src: 'sprig-windmill-palm.jpg', key: 'magenta', normalStrength: 1.75 },
  { id: 'windmill_palm_dead', src: 'sprig-windmill-palm-dead.jpg', key: 'cyan', normalStrength: 1.85 },
  // Ground Cover Undergrowth & Wildflowers
  { id: 'ground_sword_fern', src: 'ground-sword-fern.jpg', key: 'cyan', normalStrength: 1.55 },
  { id: 'ground_salal', src: 'ground-salal.jpg', key: 'cyan', normalStrength: 1.5 },
  { id: 'ground_bunchgrass', src: 'ground-bunchgrass.jpg', key: 'cyan', normalStrength: 1.4 },
  { id: 'ground_wildflowers_coastal', src: 'ground-wildflowers-coastal.jpg', key: 'cyan', normalStrength: 1.35 },
  { id: 'ground_wildflowers_rockies', src: 'ground-wildflowers-rockies.jpg', key: 'cyan', normalStrength: 1.4 },
];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

async function processSprig(spec) {
  const srcPath = path.join(CURSOR_ASSETS, spec.src);
  const outDir = path.join(OUT_ROOT, spec.id);
  await fs.mkdir(outDir, { recursive: true });

  const size = 1024;
  const { data, info } = await sharp(srcPath)
    .resize(size, size, { fit: 'cover', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const n = w * h;

  // Measure average corner color as exact key background reference
  let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      for (const [cx, cy] of [[x, y], [w - 1 - x, y], [x, h - 1 - y], [w - 1 - x, h - 1 - y]]) {
        const idx = (cy * w + cx) * 3;
        bgR += data[idx];
        bgG += data[idx + 1];
        bgB += data[idx + 2];
        bgCount++;
      }
    }
  }
  bgR /= bgCount;
  bgG /= bgCount;
  bgB /= bgCount;

  const rgba = new Uint8Array(n * 4);
  const alphaF = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];

    let a = 1;
    let fr = r;
    let fg = g;
    let fb = b;

    if (spec.key === 'green') {
      // Exact analytical green-screen matte for crimson/rose/burgundy gossamer smoke plumes:
      // True smoke pigment has F_g ~ 0.48*F_r + 0.18*F_b, so excess green measures (1 - alpha) directly!
      const expectedFg = 0.50 * r + 0.22 * b;
      const gExcess = g - expectedFg;
      if (spec.softAlpha) {
        // Silky continuous sub-pixel alpha from gossamer outermost wisps (0.02) to dense puffs (1.0)
        a = clamp(1.0 - (gExcess - 10) / Math.max(180, bgG - 16), 0, 1);
        if (a < 0.025) a = 0;
        else if (a > 0.985) a = 1;
        // Exact analytical un-premultiplication against (bgR, bgG, bgB) so wisps keep rich rose pigment
        if (a > 0.06) {
          const invA = 1.0 / Math.max(0.22, a);
          fr = clamp((r - (1 - a) * bgR) * invA, 0, 255);
          fb = clamp((b - (1 - a) * bgB) * invA, 0, 255);
          fg = clamp((g - (1 - a) * bgG) * invA, 0, 255);
          // Clamp any residual green spill strictly to pure raspberry-rose ceiling (zero yellow/peach fringe!)
          const maxRoseG = fr * 0.38 + fb * 0.12;
          if (fg > maxRoseG) fg = maxRoseG;
          // Boost blue slightly on sparse wisps so outer filaments stay cool mauve-rose instead of warm salmon
          const minRoseB = fr * 0.46;
          if (a < 0.72 && fb < minRoseB) fb = fb * 0.55 + minRoseB * 0.45;
        }
      } else {
        const bgProb = smoothstep(6, 86, gExcess);
        a = 1 - bgProb;
        if (a < 0.04) a = 0;
        else if (a > 0.97) a = 1;
        const maxG = Math.max(fr, fb) * 0.78;
        if (fg > maxG) fg = maxG;
      }
      alphaF[i] = a;
    } else {
      // Excess chroma metric: positive in pure key background, negative inside foreground foliage
      const keyMetric =
        spec.key === 'cyan'
          ? Math.min(g, b) - r // cyan has high G & B, low R
          : Math.min(r, b) - g; // magenta has high R & B, low G

      // Tight, crisp botanical alpha ramp (retains hair-thin twigs while cleanly dropping key halo)
      const bgProb = smoothstep(4, 78, keyMetric);
      a = 1 - bgProb;
      if (a < 0.04) a = 0;
      else if (a > 0.97) a = 1;
      alphaF[i] = a;

      // Spill suppression on foreground RGB so zero cyan/magenta tint survives on fine needles/tips
      if (spec.key === 'cyan') {
        const spill = Math.min(fg, fb) - fr * 0.92;
        if (spill > 0) {
          const cut = spill * (a < 0.96 ? 1.0 : 0.72);
          fg -= cut * 0.92;
          fb -= cut * 1.0;
        }
      } else {
        // Magenta spill on green conifer needles, silver-white undersides, & pale blossoms
        const greenFactor = spec.preserveWhite ? 1.02 : 0.76;
        const spill = Math.min(fr, fb) - fg * greenFactor;
        if (spill > 0) {
          const cut = spill * (a < 0.96 ? 1.0 : 0.82);
          fr -= cut * 0.88;
          fb -= cut * 1.0;
        }
        // Also neutralize faint pink rim where red > green * 1.05 on non-bark fringe pixels
        if (!spec.preserveWhite && a < 0.96 && fr > fg * 1.05 && fb > fg * 0.55) {
          fr = fg * 0.88;
          fb = fg * 0.42;
        }
      }
    }

    rgba[i * 4] = clamp(Math.round(fr), 0, 255);
    rgba[i * 4 + 1] = clamp(Math.round(fg), 0, 255);
    rgba[i * 4 + 2] = clamp(Math.round(fb), 0, 255);
    rgba[i * 4 + 3] = Math.round(a * 255);
  }

  // Iterative alpha-edge RGB dilation (24 passes) seeded strictly from clean opaque interior pixels
  // Dilating clean interior leaf RGB over BOTH fringe (0 < a < 0.92) and transparent pixels
  // eliminates 100% of chroma halos AND keeps GPU mipmaps vibrant at every distance!
  const isCleanInterior = new Uint8Array(n);
  const seedThresh = spec.softAlpha ? 0.58 : 0.92;
  const nbrThresh = spec.softAlpha ? 0.40 : 0.72;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (alphaF[idx] < seedThresh) continue;
      // Check immediate 4-neighbors so 1px antialiased rim gets painted with true interior color
      const l = x > 0 ? alphaF[idx - 1] : 0;
      const rr = x < w - 1 ? alphaF[idx + 1] : 0;
      const u = y > 0 ? alphaF[idx - w] : 0;
      const d = y < h - 1 ? alphaF[idx + w] : 0;
      if (l >= nbrThresh && rr >= nbrThresh && u >= nbrThresh && d >= nbrThresh) {
        isCleanInterior[idx] = 1;
      }
    }
  }
  const filled = new Uint8Array(isCleanInterior);
  // Fallback: if a hair-thin twig has no thick interior, keep pixels with a >= seedThresh
  for (let i = 0; i < n; i++) {
    if (!filled[i] && alphaF[i] >= (spec.softAlpha ? 0.45 : 0.95)) filled[i] = 1;
  }
  const curRGB = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    curRGB[i * 3] = rgba[i * 4];
    curRGB[i * 3 + 1] = rgba[i * 4 + 1];
    curRGB[i * 3 + 2] = rgba[i * 4 + 2];
  }
  const nextRGB = new Uint8Array(curRGB);
  const nextFilled = new Uint8Array(filled);

  for (let pass = 0; pass < 24; pass++) {
    let anyNew = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (filled[idx]) continue;
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = y + oy;
          if (ny < 0 || ny >= h) continue;
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = x + ox;
            if (nx < 0 || nx >= w) continue;
            const nIdx = ny * w + nx;
            if (filled[nIdx]) {
              sr += curRGB[nIdx * 3];
              sg += curRGB[nIdx * 3 + 1];
              sb += curRGB[nIdx * 3 + 2];
              cnt++;
            }
          }
        }
        if (cnt > 0) {
          nextRGB[idx * 3] = Math.round(sr / cnt);
          nextRGB[idx * 3 + 1] = Math.round(sg / cnt);
          nextRGB[idx * 3 + 2] = Math.round(sb / cnt);
          nextFilled[idx] = 1;
          anyNew = true;
        }
      }
    }
    curRGB.set(nextRGB);
    filled.set(nextFilled);
    if (!anyNew) break;
  }

  // Write dilated clean interior RGB back into ALL fringe & transparent pixels!
  for (let i = 0; i < n; i++) {
    if (!isCleanInterior[i]) {
      rgba[i * 4] = curRGB[i * 3];
      rgba[i * 4 + 1] = curRGB[i * 3 + 1];
      rgba[i * 4 + 2] = curRGB[i * 3 + 2];
    }
  }

  // Save 1024px (High) & 512px (Standard) RGBA WebP sprigs
  const sprigHighPath = path.join(outDir, 'sprig.webp');
  const sprigStdPath = path.join(outDir, 'sprig_512.webp');
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100, effort: 5 })
    .toFile(sprigHighPath);

  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .resize(512, 512, { kernel: 'lanczos3' })
    .webp({ quality: 88, alphaQuality: 96, effort: 5 })
    .toFile(sprigStdPath);

  // Extract 512px OpenGL Normal map from leaf/needle luminance + silhouette relief
  const norSize = 512;
  const { data: smallRgba } = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .resize(norSize, norSize, { kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const heightF = new Float32Array(norSize * norSize);
  for (let i = 0; i < norSize * norSize; i++) {
    const r = smallRgba[i * 4] / 255;
    const g = smallRgba[i * 4 + 1] / 255;
    const b = smallRgba[i * 4 + 2] / 255;
    const a = smallRgba[i * 4 + 3] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    heightF[i] = lum * a;
  }

  const norBuf = new Uint8Array(norSize * norSize * 3);
  const strength = spec.normalStrength;
  const sampleH = (x, y) => heightF[clamp(y, 0, norSize - 1) * norSize + clamp(x, 0, norSize - 1)];

  for (let y = 0; y < norSize; y++) {
    for (let x = 0; x < norSize; x++) {
      const gx =
        sampleH(x + 1, y - 1) + 2 * sampleH(x + 1, y) + sampleH(x + 1, y + 1) -
        (sampleH(x - 1, y - 1) + 2 * sampleH(x - 1, y) + sampleH(x - 1, y + 1));
      const gy =
        sampleH(x - 1, y + 1) + 2 * sampleH(x, y + 1) + sampleH(x + 1, y + 1) -
        (sampleH(x - 1, y - 1) + 2 * sampleH(x, y - 1) + sampleH(x + 1, y - 1));

      // OpenGL tangent-space normal (+X right, +Y up)
      let nx = -gx * strength;
      let ny = gy * strength;
      let nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;

      const idx = (y * norSize + x) * 3;
      norBuf[idx] = clamp(Math.round((nx * 0.5 + 0.5) * 255), 0, 255);
      norBuf[idx + 1] = clamp(Math.round((ny * 0.5 + 0.5) * 255), 0, 255);
      norBuf[idx + 2] = clamp(Math.round((nz * 0.5 + 0.5) * 255), 0, 255);
    }
  }

  const norPath = path.join(outDir, 'nor.webp');
  await sharp(norBuf, { raw: { width: norSize, height: norSize, channels: 3 } })
    .webp({ quality: 88, effort: 5 })
    .toFile(norPath);

  // Measure coverage stats
  let opaquePx = 0;
  for (let i = 0; i < n; i++) if (alphaF[i] > 0.5) opaquePx++;
  const covPct = ((opaquePx / n) * 100).toFixed(1);
  const stHigh = await fs.stat(sprigHighPath);
  const stNor = await fs.stat(norPath);
  console.log(
    `[sprig] ${spec.id}: coverage=${covPct}%, sprig.webp=${(stHigh.size / 1024).toFixed(1)} KB, nor.webp=${(stNor.size / 1024).toFixed(1)} KB`
  );
}

async function main() {
  await fs.mkdir(OUT_ROOT, { recursive: true });
  const filterIds = process.argv.slice(2);
  const targets =
    filterIds.length > 0 ? SPRIGS.filter((s) => filterIds.includes(s.id)) : SPRIGS;
  for (const s of targets) {
    await processSprig(s);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
