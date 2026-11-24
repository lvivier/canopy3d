#!/usr/bin/env node
/**
 * Fetches curated CC0 3D GLB prop models (with LOD0 + LOD1) into public/assets/models/
 * and copies Three.js local Basis/KTX2 + Draco WASM decoders into public/assets/decoders/
 * so Canopy 3D loads high-detail photorealistic props 100% self-contained and offline-ready.
 *
 * Adding a new prop:
 *   1. Add an entry to PROP_CATALOG below (either CC0 URLs or a normalized local GLB).
 *   2. Run `node scripts/fetch-prop-models.mjs`.
 *   3. Register its transform & material overrides in `src/graphics/PropModelLoader.ts`.
 *   4. Call `attachPropModel(g, '<id>', quality)` inside `src/graphics/EnvironmentBuilder.ts`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const USER_AGENT = 'Canopy3D-PropFetcher/1.0 (+https://github.com/canopy3d)';
const ROOT = path.resolve(process.cwd(), 'public', 'assets');
const MODELS_DIR = path.join(ROOT, 'models');
const DECODERS_DIR = path.join(ROOT, 'decoders');

/**
 * Curated CC0 1.0 (Public Domain) background prop catalog.
 * Each entry can provide LOD0 (High detail) and optional LOD1 (Standard/Fast detail).
 */
const PROP_CATALOG = [
  {
    id: 'truck',
    name: 'Crew-Cab Pickup Truck',
    source: 'tevy.dev',
    sourcePage: 'https://tevy.dev/models/pickup-truck',
    license: 'CC0 1.0 Universal',
    // High-detail lod0 is omitted for now. Restore lod0Url to bring it back.
    lod1Url: 'https://tevy.dev/models/pickup-truck/v1/lod1.glb',
  },
];

async function downloadFile(url, dest) {
  try {
    const st = await fs.stat(dest);
    if (st.size > 1024) {
      return { skipped: true, size: st.size };
    }
  } catch {
    // not yet present
  }
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return { skipped: false, size: buf.length };
}

async function copyDecoderDir(srcRel, destSubdir, files) {
  const srcDir = path.resolve(process.cwd(), srcRel);
  const dstDir = path.join(DECODERS_DIR, destSubdir);
  await fs.mkdir(dstDir, { recursive: true });
  for (const f of files) {
    await fs.copyFile(path.join(srcDir, f), path.join(dstDir, f));
  }
}

async function main() {
  // 1. Copy local Three.js Basis (KTX2) and Draco WASM decoders so zero external CDNs are required
  await copyDecoderDir('node_modules/three/examples/jsm/libs/basis', 'basis', [
    'basis_transcoder.js',
    'basis_transcoder.wasm',
  ]);
  await copyDecoderDir('node_modules/three/examples/jsm/libs/draco/gltf', 'draco', [
    'draco_decoder.js',
    'draco_decoder.wasm',
    'draco_wasm_wrapper.js',
  ]);
  console.log('✓ Synced local Basis/KTX2 & Draco decoders to public/assets/decoders/');

  // 2. Fetch CC0 prop GLBs
  const manifest = {
    generatedAt: new Date().toISOString(),
    models: {},
  };

  for (const prop of PROP_CATALOG) {
    const outDir = path.join(MODELS_DIR, prop.id);
    await fs.mkdir(outDir, { recursive: true });

    let lod0Rel = null;
    if (prop.lod0Url) {
      const lod0Dest = path.join(outDir, 'lod0.glb');
      const r0 = await downloadFile(prop.lod0Url, lod0Dest);
      console.log(
        `  ${prop.id}/lod0.glb (${(r0.size / 1024).toFixed(1)} KB)${r0.skipped ? ' [cached]' : ' [downloaded]'}`
      );
      lod0Rel = `/assets/models/${prop.id}/lod0.glb`;
    }

    let lod1Rel = null;
    if (prop.lod1Url) {
      const lod1Dest = path.join(outDir, 'lod1.glb');
      const r1 = await downloadFile(prop.lod1Url, lod1Dest);
      console.log(
        `  ${prop.id}/lod1.glb (${(r1.size / 1024).toFixed(1)} KB)${r1.skipped ? ' [cached]' : ' [downloaded]'}`
      );
      lod1Rel = `/assets/models/${prop.id}/lod1.glb`;
    }

    manifest.models[prop.id] = {
      name: prop.name,
      source: prop.source,
      sourcePage: prop.sourcePage,
      license: prop.license,
      ...(lod0Rel ? { lod0: lod0Rel } : {}),
      lod1: lod1Rel,
    };
  }

  await fs.writeFile(
    path.join(MODELS_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  console.log('✓ Wrote public/assets/models/manifest.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
