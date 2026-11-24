#!/usr/bin/env node
/**
 * Fetches curated CC0 PBR texture sets (2K JPG/PNG) and 1K HDRIs from Poly Haven
 * into public/assets/ for offline, self-contained rendering in Canopy 3D.
 *
 * All assets are CC0 (Public Domain) from https://polyhaven.com
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const USER_AGENT = 'Canopy3D-AssetFetcher/1.0 (+https://github.com/canopy3d)';
const ROOT = path.resolve(process.cwd(), 'public', 'assets');

const TEXTURES = [
  // Bark scans (CC0)
  { id: 'pine_bark', res: '2k' },
  { id: 'japanese_cedar_bark', res: '2k' },
  { id: 'tree_bark_03', res: '2k' },
  { id: 'bark_willow', res: '2k' },
  { id: 'bark_brown_01', res: '2k' },
  // Environment ground, rock, wood, gravel (CC0)
  { id: 'leaves_forest_ground', res: '2k' },
  { id: 'grass_path_3', res: '2k' },
  { id: 'brown_mud_leaves_01', res: '2k' },
  { id: 'mossy_rock', res: '2k' },
  { id: 'wood_planks', res: '2k' },
  { id: 'gravel_road', res: '2k' },
];

const HDRIS = [
  { id: 'rosendal_mountain_midmorning', out: 'sunny_morning.hdr', res: '1k' },
  { id: 'kloofendal_misty_morning', out: 'misty_fog.hdr', res: '1k' },
  { id: 'rogland_overcast', out: 'light_rain.hdr', res: '1k' },
  { id: 'rogland_sunset', out: 'golden_hour.hdr', res: '1k' },
  { id: 'fouriesburg_mountain_cloudy', out: 'coastal_gale.hdr', res: '1k' },
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function downloadFile(url, dest) {
  try {
    const st = await fs.stat(dest);
    if (st.size > 1024) {
      return { skipped: true, size: st.size };
    }
  } catch {
    // not present yet
  }
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return { skipped: false, size: buf.length };
}

function pickUrl(mapNode, preferredRes) {
  if (!mapNode) return null;
  const resOrder = [preferredRes, '2k', '1k'];
  for (const r of resOrder) {
    const node = mapNode[r];
    if (!node) continue;
    // Prefer jpg for smaller repo footprint, fall back to png
    if (node.jpg?.url) return { url: node.jpg.url, ext: 'jpg' };
    if (node.png?.url) return { url: node.png.url, ext: 'png' };
  }
  return null;
}

async function main() {
  let totalBytes = 0;
  const manifest = { textures: {}, hdris: {}, license: 'CC0 via Poly Haven' };

  for (const tex of TEXTURES) {
    console.log(`Fetching manifest for texture: ${tex.id}`);
    const files = await fetchJson(`https://api.polyhaven.com/files/${tex.id}`);
    const outDir = path.join(ROOT, 'textures', tex.id);
    await fs.mkdir(outDir, { recursive: true });

    const entry = {};
    const wantedMaps = [
      { key: 'diff', candidates: ['Diffuse', 'diffuse', 'diff'] },
      { key: 'nor', candidates: ['nor_gl', 'Normal'] },
      { key: 'arm', candidates: ['arm'] },
      { key: 'rough', candidates: ['Rough', 'rough'] },
    ];

    for (const m of wantedMaps) {
      // Skip separate rough if we already got ARM (R=AO, G=Roughness, B=Metalness)
      if (m.key === 'rough' && entry.arm) continue;
      let picked = null;
      for (const c of m.candidates) {
        if (files[c]) {
          picked = pickUrl(files[c], tex.res);
          if (picked) break;
        }
      }
      if (!picked) continue;
      const filename = `${m.key}.${picked.ext}`;
      const dest = path.join(outDir, filename);
      const r = await downloadFile(picked.url, dest);
      totalBytes += r.size;
      entry[m.key] = `assets/textures/${tex.id}/${filename}`;
      console.log(`  ${tex.id}/${filename}: ${(r.size / 1024).toFixed(0)} KB ${r.skipped ? '(cached)' : ''}`);
    }
    manifest.textures[tex.id] = entry;
  }

  for (const h of HDRIS) {
    console.log(`Fetching manifest for HDRI: ${h.id}`);
    const files = await fetchJson(`https://api.polyhaven.com/files/${h.id}`);
    const hdrNode = files.hdri?.[h.res]?.hdr ?? files.hdri?.['1k']?.hdr;
    if (!hdrNode?.url) {
      throw new Error(`No HDR url found for ${h.id}`);
    }
    const dest = path.join(ROOT, 'hdri', h.out);
    const r = await downloadFile(hdrNode.url, dest);
    totalBytes += r.size;
    manifest.hdris[h.out.replace('.hdr', '')] = `assets/hdri/${h.out}`;
    console.log(`  hdri/${h.out}: ${(r.size / 1024).toFixed(0)} KB ${r.skipped ? '(cached)' : ''}`);
  }

  await fs.writeFile(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nDone! Total downloaded/cached: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
