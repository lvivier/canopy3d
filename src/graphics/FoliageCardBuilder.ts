import * as THREE from 'three';
import { GraphicsQuality, SpeciesId } from '../types';
import { applyFoliageCardShader, FoliageWindUniforms } from './MaterialShaders';

export type BotanicalSprigId =
  | 'japanese_maple'
  | 'douglas_fir'
  | 'weeping_willow'
  | 'deadwood'
  | 'deadwood_conifer'
  // Group 1 — Coastal Conifers
  | 'western_red_cedar'
  | 'sitka_spruce'
  | 'western_hemlock'
  | 'california_redwood'
  // Group 2 — Interior & Alpine Conifers
  | 'ponderosa_pine'
  | 'western_larch'
  | 'blue_spruce'
  | 'western_white_pine'
  // Group 3 — PNW Native Hardwoods
  | 'bigleaf_maple'
  | 'red_alder'
  | 'garry_oak'
  | 'arbutus'
  // Group 4 — Tall Broadleafs & Poplars
  | 'white_poplar'
  | 'trembling_aspen'
  | 'eucalyptus'
  | 'chokecherry'
  | 'chokecherry_leaves'
  // Group 5 — Ornamental & Flowering Trees
  | 'lilac'
  | 'lilac_leaves'
  | 'smoke_tree'
  | 'smoke_tree_leaves'
  | 'rhododendron'
  | 'rhododendron_leaves';

interface ConiferHabitProfile {
  /** Base pitch (rad) at lower crown: negative tilts UPWARD, positive droops DOWNWARD */
  pitchLow: number;
  /** Base pitch (rad) at upper crown */
  pitchHigh: number;
  /** Longitudinal curve at lower crown: negative curls tips UPWARD, positive droops tips DOWNWARD */
  archLow: number;
  /** Longitudinal curve at upper crown */
  archHigh: number;
  /** Sub-twig lift fraction at lower -> upper crown */
  twigLiftLow: number;
  twigLiftHigh: number;
  /** Card size multiplier (higher for airy lacy needles like hemlock) */
  cardScale: number;
  /** Optional drooping lacy underside sprays (Western Red Cedar / Hemlock) */
  drapeCountHigh?: number;
  drapePitch?: number;
  /** Optional cross-card count multiplier */
  crossCountHigh: number;
}

interface BroadleafHabitProfile {
  /** Number of primary outward/layered sprig fans on High quality */
  horizCountHigh: number;
  /** Number of upper-crown lifted accent sprigs on High quality */
  topCountHigh: number;
  /** Pitch range (rad) for primary outward fans: negative = upward, positive = drooping */
  pitchMin: number;
  pitchMax: number;
  /** Upper accent sprig pitch range (rad) */
  topPitchMin: number;
  topPitchMax: number;
  /** Card scale multiplier */
  cardScale: number;
  /** Longitudinal arch droop factor */
  archDroop: number;
  /** Vertical tier stagger spread */
  tierSpread: number;
  /** Optional pendulous hanging leaf drapes (e.g. Eucalyptus) */
  drapeCountHigh?: number;
  drapeLengthMul?: number;
  /** Optional 3D billowing puff orientation for feathery cloud/smoke blooms (eliminates flat side-on card layers) */
  volumetricPuff?: boolean;
  /** Optional height-weighted bloom/leaf-only interspersing (e.g. Common Lilac: greener lower limbs, lush upright blooms up top) */
  bloomDistribution?: {
    leafOnlySprigId: BotanicalSprigId;
    lowBloomChance: number;
    highBloomChance: number;
    /** Extra upward pitch offset (negative radians) applied to blooming flower panicles */
    bloomPitchLift?: number;
  };
}

interface SprigAssetConfig {
  id: BotanicalSprigId;
  anchor: 'bottom' | 'top';
  roughness: number;
  normalScale: number;
  sssStrength: number;
  flutterScale: number;
  alphaTest: number;
  /** Optional Pass-2 gossamer feather veil threshold (renders translucent wisps softly outside the opaque core) */
  softVeilCutoff?: number;
  tintPalette: string[];
  twigColor?: string;
  coniferHabit?: ConiferHabitProfile;
  broadleafHabit?: BroadleafHabitProfile;
}

const SPRIG_CONFIGS: Record<BotanicalSprigId, SprigAssetConfig> = {
  japanese_maple: {
    id: 'japanese_maple',
    anchor: 'bottom',
    roughness: 0.66,
    normalScale: 0.55,
    sssStrength: 0.52,
    flutterScale: 1.05,
    alphaTest: 0.38,
    twigColor: '#4a302d',
    // Deep Bloodgood burgundy interior to luminous sunlit scarlet outer fans
    tintPalette: ['#ffffff', '#f2d8dc', '#ffe6df', '#e2bfc7', '#f7d5dc'],
  },
  douglas_fir: {
    id: 'douglas_fir',
    anchor: 'bottom',
    roughness: 0.82,
    normalScale: 0.65,
    sssStrength: 0.28,
    flutterScale: 0.62,
    alphaTest: 0.38,
    twigColor: '#4f3b2c',
    // Subtle Cascadia deep-emerald to sunlit spruce-green modulation
    tintPalette: ['#ffffff', '#eaf5e8', '#dfeedf', '#f4f8e6', '#d6e8d8'],
    coniferHabit: {
      pitchLow: -0.16,
      pitchHigh: -0.72,
      archLow: -0.22,
      archHigh: -0.36,
      twigLiftLow: 0.06,
      twigLiftHigh: 0.42,
      cardScale: 1.0,
      crossCountHigh: 6,
    },
  },
  // Group 1 — Coastal Conifers
  western_red_cedar: {
    id: 'western_red_cedar',
    anchor: 'bottom',
    roughness: 0.78,
    normalScale: 0.58,
    sssStrength: 0.34,
    flutterScale: 0.78,
    alphaTest: 0.36,
    twigColor: '#5c3c2a',
    // Rich deep coastal rainforest cedar emerald & sunlit olive scale sprays
    tintPalette: ['#a6c096', '#9ab58a', '#b2ca9e', '#8eaa80', '#aec494'],
    coniferHabit: {
      // Sweeping J-curve: gentle horizontal-droop mid-bough with iconic upturned J-hook outer tips + lacy underside drapes
      pitchLow: 0.14,
      pitchHigh: -0.34,
      archLow: -0.26,
      archHigh: -0.32,
      twigLiftLow: -0.08,
      twigLiftHigh: 0.18,
      cardScale: 1.08,
      drapeCountHigh: 5,
      drapePitch: 0.58,
      crossCountHigh: 5,
    },
  },
  sitka_spruce: {
    id: 'sitka_spruce',
    anchor: 'bottom',
    roughness: 0.8,
    normalScale: 0.72,
    sssStrength: 0.24,
    flutterScale: 0.52,
    alphaTest: 0.38,
    twigColor: '#574636',
    // Crisp coastal glaucous blue-green spruce needles
    tintPalette: ['#cadbd8', '#bed2d0', '#d4e2de', '#b4c8c8', '#c6d8d4'],
    coniferHabit: {
      // Stiff rigid layered horizontal-to-upturned coastal spruce whorls
      pitchLow: -0.06,
      pitchHigh: -0.58,
      archLow: -0.14,
      archHigh: -0.24,
      twigLiftLow: 0.02,
      twigLiftHigh: 0.32,
      cardScale: 1.02,
      crossCountHigh: 7,
    },
  },
  western_hemlock: {
    id: 'western_hemlock',
    anchor: 'bottom',
    roughness: 0.76,
    normalScale: 0.52,
    sssStrength: 0.38,
    flutterScale: 0.92,
    alphaTest: 0.35,
    twigColor: '#4c3e32',
    // Soft feathery deep-to-bright emerald hemlock sprays
    tintPalette: ['#a4bf96', '#98b48c', '#b0ca9e', '#8da982', '#a8c298'],
    coniferHabit: {
      // Soft graceful drooping lacy sprays with nodding tips
      pitchLow: 0.24,
      pitchHigh: -0.16,
      archLow: 0.34,
      archHigh: 0.22,
      twigLiftLow: -0.14,
      twigLiftHigh: 0.04,
      cardScale: 1.18,
      drapeCountHigh: 4,
      drapePitch: 0.62,
      crossCountHigh: 5,
    },
  },
  california_redwood: {
    id: 'california_redwood',
    anchor: 'bottom',
    roughness: 0.82,
    normalScale: 0.64,
    sssStrength: 0.28,
    flutterScale: 0.58,
    alphaTest: 0.36,
    twigColor: '#663626',
    // Deep lush fog-belt evergreen redwood sprays
    tintPalette: ['#ffffff', '#e4f0e4', '#d8e8dc', '#eef5e6', '#cddfd4'],
    coniferHabit: {
      // Wide, flat stately layered fog-belt horizontal sprays (gentle upper upsweep near spire)
      pitchLow: 0.08,
      pitchHigh: -0.34,
      archLow: 0.14,
      archHigh: -0.12,
      twigLiftLow: -0.04,
      twigLiftHigh: 0.2,
      cardScale: 1.12,
      crossCountHigh: 6,
    },
  },
  // Group 2 — Interior & Alpine Conifers
  ponderosa_pine: {
    id: 'ponderosa_pine',
    anchor: 'bottom',
    roughness: 0.8,
    normalScale: 0.68,
    sssStrength: 0.28,
    flutterScale: 0.58,
    alphaTest: 0.38,
    twigColor: '#6d432c',
    // Sun-warmed interior olive-pine green
    tintPalette: ['#c8d8b2', '#bcd0a6', '#d2dfb8', '#b0c69a', '#c4d4ac'],
    coniferHabit: {
      // Chunky sunlit long-needle tufts perched on sturdy spreading interior pine boughs
      pitchLow: -0.08,
      pitchHigh: -0.52,
      archLow: -0.18,
      archHigh: -0.28,
      twigLiftLow: 0.04,
      twigLiftHigh: 0.34,
      cardScale: 1.04,
      crossCountHigh: 7,
    },
  },
  western_larch: {
    id: 'western_larch',
    anchor: 'bottom',
    roughness: 0.72,
    normalScale: 0.55,
    sssStrength: 0.44,
    flutterScale: 0.95,
    alphaTest: 0.36,
    twigColor: '#5a4332',
    // Luminous golden-amber & honey-ochre autumn larch needles (rich without blowing out!)
    tintPalette: ['#e6c47e', '#f0cf88', '#d8b46e', '#f5d896', '#cca660'],
    coniferHabit: {
      // Airy feathery golden larch spire tiers
      pitchLow: 0.08,
      pitchHigh: -0.38,
      archLow: 0.14,
      archHigh: -0.1,
      twigLiftLow: -0.06,
      twigLiftHigh: 0.18,
      cardScale: 1.18,
      crossCountHigh: 6,
    },
  },
  blue_spruce: {
    id: 'blue_spruce',
    anchor: 'bottom',
    roughness: 0.76,
    normalScale: 0.76,
    sssStrength: 0.22,
    flutterScale: 0.46,
    alphaTest: 0.36,
    twigColor: '#5c4b3b',
    // Distinct glacier-blue & silvery powder-teal Colorado Blue Spruce needles
    tintPalette: ['#c4dce6', '#b8d4e0', '#d0e4ec', '#aecad8', '#c0d9e4'],
    coniferHabit: {
      // Dense stiff formal symmetrical spruce whorls with upturned needle tips
      pitchLow: -0.04,
      pitchHigh: -0.58,
      archLow: -0.12,
      archHigh: -0.22,
      twigLiftLow: 0.02,
      twigLiftHigh: 0.32,
      cardScale: 1.28,
      crossCountHigh: 9,
    },
  },
  western_white_pine: {
    id: 'western_white_pine',
    anchor: 'bottom',
    roughness: 0.76,
    normalScale: 0.54,
    sssStrength: 0.34,
    flutterScale: 0.85,
    alphaTest: 0.34,
    twigColor: '#544a42',
    // Soft silvery blue-green 5-needle white pine plumes
    tintPalette: ['#bfd4c8', '#b2cabf', '#cadcd0', '#a7c0b5', '#c2d6ca'],
    coniferHabit: {
      // Graceful horizontal airy layered pine plumes
      pitchLow: 0.06,
      pitchHigh: -0.34,
      archLow: 0.14,
      archHigh: -0.1,
      twigLiftLow: -0.02,
      twigLiftHigh: 0.22,
      cardScale: 1.32,
      crossCountHigh: 7,
    },
  },
  // Group 3 — PNW Native Hardwoods
  bigleaf_maple: {
    id: 'bigleaf_maple',
    anchor: 'bottom',
    roughness: 0.72,
    normalScale: 0.55,
    sssStrength: 0.44,
    flutterScale: 0.92,
    alphaTest: 0.38,
    twigColor: '#56473a',
    // Lush Cascadia emerald & warm early-gold dappled maple canopy
    tintPalette: ['#d8e6cc', '#cedec2', '#e4ecd2', '#c4d6b8', '#e6e4be'],
    broadleafHabit: {
      horizCountHigh: 13,
      topCountHigh: 8,
      pitchMin: -0.28,
      pitchMax: 0.24,
      topPitchMin: -0.92,
      topPitchMax: -0.45,
      cardScale: 1.02,
      archDroop: 0.2,
      tierSpread: 0.26,
    },
  },
  red_alder: {
    id: 'red_alder',
    anchor: 'bottom',
    roughness: 0.74,
    normalScale: 0.55,
    sssStrength: 0.4,
    flutterScale: 1.05,
    alphaTest: 0.36,
    twigColor: '#6d665c',
    // Fresh riparian forest emerald & sunlit leaf-green
    tintPalette: ['#cde0c4', '#c2d8ba', '#d8e6cc', '#b8cfb2', '#d2e2c4'],
    broadleafHabit: {
      horizCountHigh: 13,
      topCountHigh: 8,
      pitchMin: -0.38,
      pitchMax: 0.14,
      topPitchMin: -1.02,
      topPitchMax: -0.52,
      cardScale: 1.12,
      archDroop: 0.16,
      tierSpread: 0.3,
    },
  },
  garry_oak: {
    id: 'garry_oak',
    anchor: 'bottom',
    roughness: 0.74,
    normalScale: 0.62,
    sssStrength: 0.3,
    flutterScale: 0.78,
    alphaTest: 0.38,
    twigColor: '#76736a',
    // Rich deep coastal savanna oak olive-emerald (stately dark canopy silhouetted against coastal sky)
    tintPalette: ['#a4be8c', '#96b280', '#b2c898', '#8aa676', '#a8bc88'],
    broadleafHabit: {
      horizCountHigh: 12,
      topCountHigh: 7,
      pitchMin: -0.26,
      pitchMax: 0.24,
      topPitchMin: -0.9,
      topPitchMax: -0.44,
      cardScale: 1.0,
      archDroop: 0.16,
      tierSpread: 0.24,
    },
  },
  arbutus: {
    id: 'arbutus',
    anchor: 'bottom',
    roughness: 0.74,
    normalScale: 0.56,
    sssStrength: 0.22,
    flutterScale: 0.7,
    alphaTest: 0.38,
    twigColor: '#8f472e',
    // Authentic Pacific Madrone dark coastal evergreen oval leaves (berry-free, leathery sheen without white glare)
    tintPalette: ['#b4cca8', '#aac49e', '#c0d6b2', '#9eb894', '#b8cea8'],
    broadleafHabit: {
      horizCountHigh: 10,
      topCountHigh: 6,
      pitchMin: -0.34,
      pitchMax: 0.18,
      topPitchMin: -0.9,
      topPitchMax: -0.44,
      cardScale: 0.96,
      archDroop: 0.14,
      tierSpread: 0.24,
    },
  },
  // Group 4 — Tall Broadleafs & Poplars
  white_poplar: {
    id: 'white_poplar',
    anchor: 'bottom',
    roughness: 0.72,
    normalScale: 0.52,
    sssStrength: 0.32,
    flutterScale: 1.32,
    alphaTest: 0.36,
    twigColor: '#8d8c84',
    // Shimmering deep emerald + silvery-white poplar undersides (gentle tint avoids blown-out white)
    tintPalette: ['#dfe6e0', '#d4ded8', '#e6ece4', '#cbd8d2', '#dce4de'],
    broadleafHabit: {
      horizCountHigh: 13,
      topCountHigh: 8,
      pitchMin: -0.42,
      pitchMax: 0.14,
      topPitchMin: -1.04,
      topPitchMax: -0.52,
      cardScale: 1.04,
      archDroop: 0.16,
      tierSpread: 0.3,
    },
  },
  trembling_aspen: {
    id: 'trembling_aspen',
    anchor: 'bottom',
    roughness: 0.64,
    normalScale: 0.45,
    sssStrength: 0.46,
    flutterScale: 1.65,
    alphaTest: 0.35,
    twigColor: '#b5b0a2',
    // Glowing autumn golden-yellow & warm sunlit amber quaking aspen coins
    tintPalette: ['#f0d68c', '#e6c87a', '#f6df98', '#dab96b', '#ecd084'],
    broadleafHabit: {
      horizCountHigh: 14,
      topCountHigh: 9,
      pitchMin: -0.46,
      pitchMax: 0.12,
      topPitchMin: -1.06,
      topPitchMax: -0.55,
      cardScale: 1.18,
      archDroop: 0.14,
      tierSpread: 0.32,
    },
  },
  eucalyptus: {
    id: 'eucalyptus',
    anchor: 'top',
    roughness: 0.7,
    normalScale: 0.52,
    sssStrength: 0.34,
    flutterScale: 1.38,
    alphaTest: 0.35,
    twigColor: '#a69e8e',
    // Powdery silver-blue & coastal sage-eucalyptus pendulous sickle leaves
    tintPalette: ['#cde0dc', '#c2d8d6', '#d8e8e2', '#b8d0d0', '#cae0da'],
    broadleafHabit: {
      horizCountHigh: 11,
      topCountHigh: 6,
      pitchMin: 0.24,
      pitchMax: 0.68,
      topPitchMin: 0.08,
      topPitchMax: 0.44,
      cardScale: 1.24,
      archDroop: 0.42,
      tierSpread: 0.28,
      drapeCountHigh: 10,
      drapeLengthMul: 1.52,
    },
  },
  chokecherry: {
    id: 'chokecherry',
    anchor: 'bottom',
    roughness: 0.68,
    normalScale: 0.54,
    sssStrength: 0.34,
    flutterScale: 0.96,
    alphaTest: 0.36,
    twigColor: '#5b3f36',
    // Deep cherry-green leaves with creamy-white racemes & ruby chokecherries
    tintPalette: ['#e2e8de', '#d8e2d4', '#ebf0e4', '#d0dccb', '#e4eadc'],
    broadleafHabit: {
      horizCountHigh: 14,
      topCountHigh: 9,
      pitchMin: -0.32,
      pitchMax: 0.2,
      topPitchMin: -0.94,
      topPitchMax: -0.46,
      cardScale: 1.12,
      archDroop: 0.18,
      tierSpread: 0.28,
      bloomDistribution: {
        leafOnlySprigId: 'chokecherry_leaves',
        lowBloomChance: 0.18,
        highBloomChance: 0.78,
        bloomPitchLift: -0.22,
      },
    },
  },
  chokecherry_leaves: {
    id: 'chokecherry_leaves',
    anchor: 'bottom',
    roughness: 0.7,
    normalScale: 0.52,
    sssStrength: 0.34,
    flutterScale: 1.0,
    alphaTest: 0.36,
    twigColor: '#5b3f36',
    // Lush serrated emerald-green cherry foliage for lower branches & inner crown
    tintPalette: ['#d6e6ce', '#cadec2', '#e0eed6', '#bed4b8', '#d2e2ca'],
  },
  // Group 5 — Ornamental & Flowering Trees
  lilac: {
    id: 'lilac',
    anchor: 'bottom',
    roughness: 0.72,
    normalScale: 0.56,
    sssStrength: 0.36,
    flutterScale: 0.92,
    alphaTest: 0.38,
    twigColor: '#5c4e44',
    // Fragrant lavender-violet panicles & heart-shaped emerald leaves
    tintPalette: ['#ede4f6', '#e4d8f2', '#f4ecf9', '#dccced', '#eae0f4'],
    broadleafHabit: {
      horizCountHigh: 13,
      topCountHigh: 10,
      pitchMin: -0.42,
      pitchMax: 0.16,
      topPitchMin: -1.18,
      topPitchMax: -0.68,
      cardScale: 1.0,
      archDroop: 0.12,
      tierSpread: 0.25,
      bloomDistribution: {
        leafOnlySprigId: 'lilac_leaves',
        lowBloomChance: 0.16,
        highBloomChance: 0.86,
        bloomPitchLift: -0.34,
      },
    },
  },
  lilac_leaves: {
    id: 'lilac_leaves',
    anchor: 'bottom',
    roughness: 0.74,
    normalScale: 0.54,
    sssStrength: 0.34,
    flutterScale: 0.96,
    alphaTest: 0.38,
    twigColor: '#5c4e44',
    // Lush heart-shaped pure green lilac foliage framing the blooms & lower branches
    tintPalette: ['#d4e8c8', '#c8e0bc', '#def0d0', '#bcd6b2', '#d0e4c4'],
  },
  smoke_tree: {
    id: 'smoke_tree',
    anchor: 'bottom',
    roughness: 0.88,
    normalScale: 0.30,
    sssStrength: 0.34,
    flutterScale: 1.15,
    alphaTest: 0.62,
    softVeilCutoff: 0.62,
    twigColor: '#4c2c38',
    // Rich raspberry-crimson & dusty wine-rose billowing Cotinus smoke plumes
    tintPalette: ['#dc9cb2', '#cd87a0', '#e6a9be', '#bf7792', '#d590a8'],
    broadleafHabit: {
      horizCountHigh: 12,
      topCountHigh: 11,
      pitchMin: -0.34,
      pitchMax: 0.22,
      topPitchMin: -1.12,
      topPitchMax: -0.44,
      cardScale: 1.18,
      archDroop: 0.14,
      tierSpread: 0.34,
      volumetricPuff: true,
      bloomDistribution: {
        leafOnlySprigId: 'smoke_tree_leaves',
        lowBloomChance: 0.36,
        highBloomChance: 0.88,
        bloomPitchLift: -0.18,
      },
    },
  },
  smoke_tree_leaves: {
    id: 'smoke_tree_leaves',
    anchor: 'bottom',
    roughness: 0.72,
    normalScale: 0.52,
    sssStrength: 0.34,
    flutterScale: 1.02,
    alphaTest: 0.36,
    twigColor: '#4c2c38',
    // Deep Royal Purple rounded plum-burgundy leaves peeking through interior pockets & lower forks
    tintPalette: ['#dfc2d0', '#d2b2c2', '#e8ccd8', '#c6a4b6', '#dab8c8'],
  },
  rhododendron: {
    id: 'rhododendron',
    anchor: 'bottom',
    roughness: 0.64,
    normalScale: 0.6,
    sssStrength: 0.26,
    flutterScale: 0.68,
    alphaTest: 0.38,
    twigColor: '#564538',
    // Glossy evergreen rosettes crowned with vivid magenta-rose floral trusses
    tintPalette: ['#e6e2e6', '#dcd6dc', '#eeeaf0', '#d2ccd4', '#e4dee4'],
    broadleafHabit: {
      horizCountHigh: 11,
      topCountHigh: 7,
      pitchMin: -0.36,
      pitchMax: 0.18,
      topPitchMin: -0.96,
      topPitchMax: -0.46,
      cardScale: 0.96,
      archDroop: 0.16,
      tierSpread: 0.24,
      bloomDistribution: {
        leafOnlySprigId: 'rhododendron_leaves',
        lowBloomChance: 0.16,
        highBloomChance: 0.78,
        bloomPitchLift: -0.22,
      },
    },
  },
  rhododendron_leaves: {
    id: 'rhododendron_leaves',
    anchor: 'bottom',
    roughness: 0.58,
    normalScale: 0.62,
    sssStrength: 0.22,
    flutterScale: 0.64,
    alphaTest: 0.38,
    twigColor: '#564538',
    // Glossy dark evergreen leathery rhododendron leaf whorls for lower/shaded limbs
    tintPalette: ['#d8e2d8', '#cedace', '#e0eae0', '#c4d2c4', '#d4ded4'],
  },
  weeping_willow: {
    id: 'weeping_willow',
    anchor: 'top',
    roughness: 0.7,
    normalScale: 0.48,
    sssStrength: 0.42,
    flutterScale: 1.45,
    alphaTest: 0.36,
    twigColor: '#5b563c',
    // Rich natural willow-olive & sunlit chartreuse-sage (avoids washed-out neon look)
    tintPalette: ['#e6eed0', '#dce8c2', '#edf2d6', '#d1e1b6', '#f2f3d4'],
  },
  deadwood: {
    id: 'deadwood',
    anchor: 'bottom',
    roughness: 0.92,
    normalScale: 0.85,
    sssStrength: 0.05,
    flutterScale: 0.35,
    alphaTest: 0.38,
    tintPalette: ['#ffffff', '#ede4d8', '#e3d8c9', '#d8cbb8'],
  },
  deadwood_conifer: {
    id: 'deadwood_conifer',
    anchor: 'bottom',
    roughness: 0.92,
    normalScale: 0.88,
    sssStrength: 0.06,
    flutterScale: 0.32,
    alphaTest: 0.38,
    tintPalette: ['#ffffff', '#f2e4d6', '#e6d6c4', '#dbcab6'],
  },
};

export function isBotanicalPrototypeSpecies(speciesId: SpeciesId): boolean {
  return speciesId in SPRIG_CONFIGS;
}

/** Flowering species keep a separate leaf sprig; particles should shed leaves, not only blooms. */
const LEAF_PARTICLE_SPRIG: Partial<Record<SpeciesId, BotanicalSprigId>> = {
  chokecherry: 'chokecherry_leaves',
  lilac: 'lilac_leaves',
  smoke_tree: 'smoke_tree_leaves',
  rhododendron: 'rhododendron_leaves',
};

export interface FoliageParticleSprite {
  map: THREE.Texture;
  alphaTest: number;
}

/** Alpha-tested sprig used when a cut limb throws foliage. Reuses the tree's cached texture. */
export function getFoliageParticleSprite(
  speciesId: SpeciesId,
  quality: GraphicsQuality,
  opts: { deadwood?: boolean; category?: 'conifer' | 'deciduous' } = {}
): FoliageParticleSprite | null {
  let id: BotanicalSprigId;
  if (opts.deadwood) {
    id = opts.category === 'conifer' ? 'deadwood_conifer' : 'deadwood';
  } else if (isBotanicalPrototypeSpecies(speciesId)) {
    id = LEAF_PARTICLE_SPRIG[speciesId] ?? (speciesId as BotanicalSprigId);
  } else {
    return null;
  }
  const tex = getSprigTextures(id, quality);
  return { map: tex.map, alphaTest: SPRIG_CONFIGS[id].alphaTest };
}

interface CachedSprigTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  depthMaterial: THREE.MeshDepthMaterial;
}

const textureLoader = new THREE.TextureLoader();
const sprigTextureCache = new Map<string, CachedSprigTextures>();

function getSprigTextures(
  id: BotanicalSprigId,
  quality: GraphicsQuality
): CachedSprigTextures {
  const key = `${id}|${quality}`;
  const existing = sprigTextureCache.get(key);
  if (existing) return existing;

  const baseRaw =
    (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  const basePrefix = baseRaw.endsWith('/') ? baseRaw : `${baseRaw}/`;
  const base = `${basePrefix}assets/foliage/${id}`;
  const mapUrl = quality === 'high' ? `${base}/sprig.webp` : `${base}/sprig_512.webp`;
  const map = textureLoader.load(mapUrl);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = quality === 'high' ? 8 : 4;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;

  let normalMap: THREE.Texture | null = null;
  if (quality === 'high') {
    normalMap = textureLoader.load(`${base}/nor.webp`);
    normalMap.colorSpace = THREE.NoColorSpace;
    normalMap.wrapS = THREE.ClampToEdgeWrapping;
    normalMap.wrapT = THREE.ClampToEdgeWrapping;
    normalMap.anisotropy = 4;
  }

  const cfg = SPRIG_CONFIGS[id];
  // Alpha-tested depth material casts true leaf/needle dappled shadows onto terrain & structures!
  const depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map,
    alphaTest: cfg.alphaTest,
  });

  const entry: CachedSprigTextures = { map, normalMap, depthMaterial };
  sprigTextureCache.set(key, entry);
  return entry;
}

export interface TreeBotanicalContext {
  speciesId: SpeciesId;
  category: 'conifer' | 'deciduous';
  quality: GraphicsQuality;
  liveMat: THREE.MeshStandardMaterial;
  liveDepthMat: THREE.MeshDepthMaterial;
  liveVeilMat?: THREE.MeshStandardMaterial;
  leafOnlyMat?: THREE.MeshStandardMaterial;
  leafOnlyDepthMat?: THREE.MeshDepthMaterial;
  deadMat: THREE.MeshStandardMaterial;
  deadDepthMat: THREE.MeshDepthMaterial;
  twigMat: THREE.MeshStandardMaterial;
}

function createTreeSprigMaterial(
  id: BotanicalSprigId,
  quality: GraphicsQuality,
  windUniforms?: FoliageWindUniforms
): {
  mat: THREE.MeshStandardMaterial;
  depthMat: THREE.MeshDepthMaterial;
  veilMat?: THREE.MeshStandardMaterial;
} {
  const cfg = SPRIG_CONFIGS[id];
  const tex = getSprigTextures(id, quality);

  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: quality === 'high' ? tex.normalMap : null,
    normalScale: new THREE.Vector2(cfg.normalScale, cfg.normalScale),
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaTest: cfg.alphaTest,
    roughness: cfg.roughness,
    metalness: 0.02,
    envMapIntensity: quality === 'high' ? 0.36 : 0.6,
  });

  if (windUniforms) {
    applyFoliageCardShader(mat, windUniforms, {
      anchor: cfg.anchor,
      sssStrength: quality === 'high' ? cfg.sssStrength : cfg.sssStrength * 0.45,
      flutterScale: cfg.flutterScale,
    });
  }

  // Optional Pass-2 gossamer feather veil material (silky semi-transparent smoke plumes!)
  let veilMat: THREE.MeshStandardMaterial | undefined;
  if (cfg.softVeilCutoff && cfg.softVeilCutoff > 0) {
    veilMat = new THREE.MeshStandardMaterial({
      map: tex.map,
      normalMap: quality === 'high' ? tex.normalMap : null,
      normalScale: new THREE.Vector2(cfg.normalScale * 0.65, cfg.normalScale * 0.65),
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      alphaTest: 0,
      roughness: Math.min(0.95, cfg.roughness + 0.06),
      metalness: 0.0,
      envMapIntensity: quality === 'high' ? 0.38 : 0.55,
    });
    if (windUniforms) {
      applyFoliageCardShader(veilMat, windUniforms, {
        anchor: cfg.anchor,
        sssStrength: quality === 'high' ? cfg.sssStrength * 1.15 : cfg.sssStrength * 0.5,
        flutterScale: cfg.flutterScale,
        softVeilMaxAlpha: cfg.softVeilCutoff,
      });
    }
  }

  return { mat, depthMat: tex.depthMaterial, veilMat };
}

/**
 * Allocates per-tree shared botanical sprig materials (1 live + 1 deadwood)
 * so every cluster batches cleanly while preserving isolated per-tree camera occlusion fading!
 */
export function createTreeBotanicalContext(
  speciesId: SpeciesId,
  category: 'conifer' | 'deciduous',
  quality: GraphicsQuality,
  barkMat: THREE.Material,
  windUniforms?: FoliageWindUniforms
): TreeBotanicalContext | null {
  if (!isBotanicalPrototypeSpecies(speciesId)) return null;

  const liveId = speciesId as BotanicalSprigId;
  const deadId: BotanicalSprigId = category === 'conifer' ? 'deadwood_conifer' : 'deadwood';
  const live = createTreeSprigMaterial(liveId, quality, windUniforms);
  const dead = createTreeSprigMaterial(deadId, quality, windUniforms);
  const leafOnlyId = SPRIG_CONFIGS[liveId]?.broadleafHabit?.bloomDistribution?.leafOnlySprigId;
  const leafOnly = leafOnlyId ? createTreeSprigMaterial(leafOnlyId, quality, windUniforms) : null;

  // Dark delicate sub-twig bark material matching the tree's species bark
  const twigColor =
    SPRIG_CONFIGS[liveId]?.twigColor ??
    (category === 'conifer' ? '#4f3b2c' : '#534338');
  const twigMat =
    barkMat instanceof THREE.MeshStandardMaterial
      ? new THREE.MeshStandardMaterial({
          color: twigColor,
          roughness: 0.9,
          metalness: 0.02,
        })
      : new THREE.MeshStandardMaterial({ color: twigColor, roughness: 0.9 });

  return {
    speciesId,
    category,
    quality,
    liveMat: live.mat,
    liveDepthMat: live.depthMat,
    liveVeilMat: live.veilMat,
    leafOnlyMat: leafOnly?.mat,
    leafOnlyDepthMat: leafOnly?.depthMat,
    deadMat: dead.mat,
    deadDepthMat: dead.depthMat,
    twigMat,
  };
}

// Reusable scratch buffers for zero-GC-churn geometry merging
const _vPos = new THREE.Vector3();
const _vNorm = new THREE.Vector3();
const _vOut = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scaleVec = new THREE.Vector3(1, 1, 1);
const _posVec = new THREE.Vector3();
const _normalMat = new THREE.Matrix3();
const _tintCol = new THREE.Color();

interface CardBuildBuffer {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
  vertOffset: number;
}

function makeBuffer(): CardBuildBuffer {
  return {
    positions: [],
    normals: [],
    uvs: [],
    colors: [],
    indices: [],
    vertOffset: 0,
  };
}

/**
 * Appends a single curved 3D arched & lightly V-cupped botanical sprig card (3x2 grid = 12 tris)
 * into a merged cluster BufferGeometry, blending local surface normal with transferred
 * canopy-outward volumetric normal + baked interior-to-exterior canopy cavity AO!
 */
function appendCurvedSprigCard(
  buf: CardBuildBuffer,
  opts: {
    origin: THREE.Vector3;
    yaw: number;
    pitch: number; // 0 = extending along +Z horizontally, +PI/2 = straight down, -PI/2 = straight up
    roll: number;
    width: number;
    length: number;
    archDroop: number; // + bends downward along length, - arches upward
    cupDepth: number; // gentle cross-sectional camber so card never vanishes edge-on
    flipU: boolean;
    anchor: 'bottom' | 'top';
    aoCenter: THREE.Vector3;
    aoRadius: number;
    aoMin: number;
    aoMax: number;
    tint: THREE.Color;
    normalTransferWeight: number;
  }
): void {
  const segW = 2; // 3 columns across width
  const segL = 3; // 4 rows along length

  // Build world-in-cluster transform: card extends along +Z (0..length), width along X (-w/2..+w/2), arch along Y
  _euler.set(opts.pitch, opts.yaw, opts.roll, 'YXZ');
  _quat.setFromEuler(_euler);
  _posVec.copy(opts.origin);
  _mat4.compose(_posVec, _quat, _scaleVec);
  _normalMat.getNormalMatrix(_mat4);

  const baseIdx = buf.vertOffset;

  for (let il = 0; il <= segL; il++) {
    const t = il / segL; // 0 at attachment anchor -> 1 at outer leaf/strand tip
    const z = t * opts.length;
    // Gentle arch along length: rises slightly near base then droops gracefully toward tip
    const archY = Math.sin(t * Math.PI) * opts.archDroop * 0.25 - t * t * opts.archDroop;
    // Derivative dY/dZ for local curved tangent normal
    const dYdZ =
      (Math.cos(t * Math.PI) * Math.PI * opts.archDroop * 0.25 - 2 * t * opts.archDroop) /
      Math.max(0.05, opts.length);

    for (let iw = 0; iw <= segW; iw++) {
      const s = iw / segW; // 0..1 across width
      const sn = s * 2 - 1; // -1..+1
      const x = sn * opts.width * 0.5;
      // Cross-sectional camber (V-cup) so card always shows 3D depth edge-on
      const cupY = (1 - sn * sn) * opts.cupDepth;
      const dYdX = (-2 * sn * opts.cupDepth) / Math.max(0.05, opts.width * 0.5);

      const y = archY + cupY;

      // Local curved surface normal (+Y upward before rotation)
      _vNorm.set(-dYdX, 1, -dYdZ).normalize().applyMatrix3(_normalMat).normalize();

      // Transform vertex position into cluster local space
      _vPos.set(x, y, z).applyMatrix4(_mat4);

      // Transferred volumetric canopy-outward normal (SpeedTree / Ghost of Tsushima technique)
      _vOut.copy(_vPos).sub(opts.aoCenter);
      _vOut.y += opts.aoRadius * 0.42; // slight upward skyward dome bias for soft sunlit tops
      if (_vOut.lengthSq() > 1e-5) {
        _vOut.normalize();
      } else {
        _vOut.set(0, 1, 0);
      }
      _vNorm.lerp(_vOut, opts.normalTransferWeight).normalize();

      // Baked interior-to-exterior canopy AO (darker interior core -> bright sunlit outer leaves)
      const distFrac = THREE.MathUtils.clamp(
        _vPos.distanceTo(opts.aoCenter) / Math.max(0.25, opts.aoRadius),
        0,
        1.15
      );
      const upBias = THREE.MathUtils.clamp(
        (_vPos.y - opts.aoCenter.y) / Math.max(0.4, opts.aoRadius) * 0.16 + 0.06,
        -0.12,
        0.16
      );
      const ao = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(opts.aoMin, opts.aoMax, Math.min(1, distFrac * 0.92)) + upBias,
        0.48,
        1.14
      );

      const u = opts.flipU ? 1 - s : s;
      // Anchor='bottom': UV v=0 at stem base (t=0), v=1 at tip (t=1)
      // Anchor='top':    UV v=1 at hanging top anchor (t=0), v=0 at drooping strand tip (t=1)
      const v = opts.anchor === 'bottom' ? t : 1 - t;

      buf.positions.push(_vPos.x, _vPos.y, _vPos.z);
      buf.normals.push(_vNorm.x, _vNorm.y, _vNorm.z);
      buf.uvs.push(u, v);
      buf.colors.push(opts.tint.r * ao, opts.tint.g * ao, opts.tint.b * ao);
      buf.vertOffset++;
    }
  }

  const stride = segW + 1;
  for (let il = 0; il < segL; il++) {
    for (let iw = 0; iw < segW; iw++) {
      const a = baseIdx + il * stride + iw;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      buf.indices.push(a, c, b, b, c, d);
    }
  }
}

/**
 * Appends a tapered 4-sided woody 2nd-order sub-twig into a lightweight merged twig buffer.
 */
function appendSubTwig(
  buf: CardBuildBuffer,
  start: THREE.Vector3,
  end: THREE.Vector3,
  rBase: number,
  rTip: number
): void {
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = dir.length();
  if (len < 0.04) return;
  dir.divideScalar(len);

  const up = Math.abs(dir.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const sideA = new THREE.Vector3().crossVectors(dir, up).normalize();
  const sideB = new THREE.Vector3().crossVectors(dir, sideA).normalize();

  const segs = 4;
  const baseIdx = buf.vertOffset;
  for (let ring = 0; ring < 2; ring++) {
    const c = ring === 0 ? start : end;
    const r = ring === 0 ? rBase : rTip;
    for (let s = 0; s < segs; s++) {
      const ang = (s / segs) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const nx = sideA.x * ca + sideB.x * sa;
      const ny = sideA.y * ca + sideB.y * sa;
      const nz = sideA.z * ca + sideB.z * sa;
      buf.positions.push(c.x + nx * r, c.y + ny * r, c.z + nz * r);
      buf.normals.push(nx, ny, nz);
      buf.uvs.push(s / segs, ring);
      buf.colors.push(1, 1, 1);
      buf.vertOffset++;
    }
  }
  for (let s = 0; s < segs; s++) {
    const next = (s + 1) % segs;
    const a = baseIdx + s;
    const b = baseIdx + next;
    const c = baseIdx + segs + s;
    const d = baseIdx + segs + next;
    buf.indices.push(a, c, b, b, c, d);
  }
}

function finalizeBufferGeometry(buf: CardBuildBuffer, withColors: boolean): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uvs, 2));
  if (withColors) {
    geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.colors, 3));
  }
  geo.setIndex(buf.indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Builds a realistic species-specific botanical sprig foliage cluster (2nd-order sub-twigs +
 * curved 3D arched sprig cards + transferred volumetric normals + canopy AO + alpha-tested shadows).
 */
export function buildBotanicalFoliageCluster(
  ctx: TreeBotanicalContext,
  scale: number,
  rand: () => number,
  isDeadwood: boolean,
  outwardHint?: THREE.Vector3,
  crownHeightFrac = 0.5
): THREE.Group {
  const group = new THREE.Group();
  group.userData = { isFoliage: true, isBotanicalSprigGroup: true };

  const sprigId: BotanicalSprigId = isDeadwood
    ? ctx.category === 'conifer'
      ? 'deadwood_conifer'
      : 'deadwood'
    : (ctx.speciesId as BotanicalSprigId);
  const cfg = SPRIG_CONFIGS[sprigId];
  const isHigh = ctx.quality === 'high';
  const hFrac = THREE.MathUtils.clamp(crownHeightFrac, 0, 1);

  const cardBuf = makeBuffer();
  const leafCardBuf = makeBuffer();
  const twigBuf = makeBuffer();

  const pickTintFrom = (palette: string[]): THREE.Color => {
    const hex = palette[Math.floor(rand() * palette.length)];
    _tintCol.set(hex);
    // Subtle organic lightness & warmth jitter per sprig card
    _tintCol.offsetHSL((rand() - 0.5) * 0.014, (rand() - 0.5) * 0.04, (rand() - 0.5) * 0.05);
    return _tintCol.clone();
  };
  const pickTint = (): THREE.Color => pickTintFrom(cfg.tintPalette);

  const baseYaw = outwardHint
    ? Math.atan2(outwardHint.x, outwardHint.z)
    : rand() * Math.PI * 2;

  const aoCenter = new THREE.Vector3(0, -scale * 0.14, 0);

  if (isDeadwood) {
    // Brittle gnarled deadwood limb: visible forked dry twigs + sparse splayed dead sprig cards
    const twigCount = 4;
    const twigTips: THREE.Vector3[] = [];
    for (let t = 0; t < twigCount; t++) {
      const a = baseYaw + (t / twigCount) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const len = scale * (0.52 + rand() * 0.32);
      const end = new THREE.Vector3(
        Math.sin(a) * len,
        (rand() - 0.35) * scale * 0.36,
        Math.cos(a) * len
      );
      appendSubTwig(twigBuf, new THREE.Vector3(0, 0, 0), end, scale * 0.045, scale * 0.014);
      twigTips.push(end);
    }

    const cardCount = isHigh ? 10 : 7;
    for (let i = 0; i < cardCount; i++) {
      const a = baseYaw + (i / cardCount) * Math.PI * 2 + (rand() - 0.5) * 0.55;
      const tip = twigTips[i % twigTips.length];
      const origin = tip.clone().multiplyScalar(0.35 + rand() * 0.45);
      const pitch = -0.35 + rand() * 0.72; // irregular splayed dead angles
      appendCurvedSprigCard(cardBuf, {
        origin,
        yaw: a,
        pitch,
        roll: (rand() - 0.5) * 0.75,
        width: scale * (1.28 + rand() * 0.42),
        length: scale * (1.32 + rand() * 0.45),
        archDroop: scale * (0.12 + rand() * 0.16),
        cupDepth: scale * 0.12,
        flipU: rand() < 0.5,
        anchor: 'bottom',
        aoCenter,
        aoRadius: scale * 1.45,
        aoMin: 0.66,
        aoMax: 1.04,
        tint: pickTint(),
        normalTransferWeight: 0.62,
      });
    }
  } else if (ctx.speciesId === 'japanese_maple') {
    // Japanese Maple ('Bloodgood'):
    // Sculptural dark spreading 2nd-order twigs supporting airy, layered horizontal crimson palmate fans!
    const twigCount = 5;
    const twigAnchors: Array<{ pos: THREE.Vector3; yaw: number }> = [];
    for (let t = 0; t < twigCount; t++) {
      const a = baseYaw + (t / twigCount) * Math.PI * 2 + (rand() - 0.5) * 0.45;
      const len = scale * (0.55 + rand() * 0.38);
      const lift = scale * (0.04 + (t % 2) * 0.14 - 0.08 + (rand() - 0.5) * 0.1);
      const end = new THREE.Vector3(Math.sin(a) * len, lift, Math.cos(a) * len);
      appendSubTwig(twigBuf, new THREE.Vector3(0, -scale * 0.08, 0), end, scale * 0.04, scale * 0.012);
      twigAnchors.push({ pos: end, yaw: a });

      // Secondary delicate V-fork off each twig
      const subA = a + (t % 2 === 0 ? 0.55 : -0.55);
      const mid = end.clone().multiplyScalar(0.55);
      const subEnd = mid
        .clone()
        .add(new THREE.Vector3(Math.sin(subA) * len * 0.52, scale * 0.08, Math.cos(subA) * len * 0.52));
      appendSubTwig(twigBuf, mid, subEnd, scale * 0.022, scale * 0.009);
      twigAnchors.push({ pos: subEnd, yaw: subA });
    }

    // Layer 1: Graceful horizontal / gently spreading tiered maple fans (the signature Japanese Maple cloud layers!)
    const horizCount = isHigh ? 14 : 9;
    for (let i = 0; i < horizCount; i++) {
      const tier = i % 3; // 3 staggered vertical micro-tiers
      const anchorObj = twigAnchors[i % twigAnchors.length];
      const a = anchorObj.yaw + (rand() - 0.5) * 0.72;
      const radFrac = 0.25 + rand() * 0.6;
      const origin = new THREE.Vector3(
        anchorObj.pos.x * radFrac,
        (tier - 1) * scale * 0.22 + (rand() - 0.5) * scale * 0.09,
        anchorObj.pos.z * radFrac
      );
      // Slight gentle outward droop (0.05..0.28 rad) so maple leaves form lacy flat-arched fans
      const pitch = -0.14 + rand() * 0.42;
      appendCurvedSprigCard(cardBuf, {
        origin,
        yaw: a,
        pitch,
        roll: (rand() - 0.5) * 0.36,
        width: scale * (1.55 + rand() * 0.52),
        length: scale * (1.52 + rand() * 0.48),
        archDroop: scale * (0.2 + rand() * 0.18),
        cupDepth: scale * 0.14,
        flipU: rand() < 0.5,
        anchor: 'bottom',
        aoCenter,
        aoRadius: scale * 1.85,
        aoMin: 0.52,
        aoMax: 1.08,
        tint: pickTint(),
        normalTransferWeight: 0.74,
      });
    }

    // Layer 2: Upper-crown angled/lifted accent sprigs so the canopy has lacy depth from side AND top-down views!
    const topCount = isHigh ? 6 : 4;
    for (let i = 0; i < topCount; i++) {
      const a = baseYaw + (i / topCount) * Math.PI * 2 + rand() * 0.5;
      const r = scale * (0.12 + rand() * 0.28);
      const origin = new THREE.Vector3(
        Math.sin(a) * r,
        scale * (0.08 + rand() * 0.22),
        Math.cos(a) * r
      );
      const pitch = -0.68 - rand() * 0.38; // angled upward-outward to break up horizontal flatness
      appendCurvedSprigCard(cardBuf, {
        origin,
        yaw: a,
        pitch,
        roll: (rand() - 0.5) * 0.48,
        width: scale * (1.38 + rand() * 0.42),
        length: scale * (1.35 + rand() * 0.42),
        archDroop: scale * 0.18,
        cupDepth: scale * 0.15,
        flipU: rand() < 0.5,
        anchor: 'bottom',
        aoCenter,
        aoRadius: scale * 1.85,
        aoMin: 0.72,
        aoMax: 1.1,
        tint: pickTint(),
        normalTransferWeight: 0.72,
      });
    }
  } else if (cfg.coniferHabit) {
    // Species-tuned conifer bough builder (Douglas Fir, Western Red Cedar, Sitka Spruce, Western Hemlock, California Redwood, etc.)
    const habit = cfg.coniferHabit;
    const cs = habit.cardScale;
    const boughCount = 4;
    for (let b = 0; b < boughCount; b++) {
      const a = baseYaw + (b - (boughCount - 1) * 0.5) * 0.85 + (rand() - 0.5) * 0.3;
      const len = scale * (0.58 + rand() * 0.32);
      const liftY =
        scale * (THREE.MathUtils.lerp(habit.twigLiftLow, habit.twigLiftHigh, hFrac) + (rand() - 0.5) * 0.12);
      const end = new THREE.Vector3(Math.sin(a) * len, liftY, Math.cos(a) * len);
      appendSubTwig(twigBuf, new THREE.Vector3(0, -0.02 * scale, 0), end, scale * 0.055, scale * 0.016);
    }

    // Layer 1: Primary outward-sweeping species-specific conifer bough sprays
    const fanCount = isHigh ? 14 : 9;
    const basePitch = THREE.MathUtils.lerp(habit.pitchLow, habit.pitchHigh, hFrac);
    const tipArch = scale * THREE.MathUtils.lerp(habit.archLow, habit.archHigh, hFrac);
    for (let i = 0; i < fanCount; i++) {
      const spread =
        hFrac > 0.92
          ? (i / fanCount) * Math.PI * 2
          : i < fanCount * 0.72
            ? ((i / (fanCount * 0.72)) * 2 - 1) * 1.38
            : (i / fanCount) * Math.PI * 2;
      const a = baseYaw + spread + (rand() - 0.5) * 0.35;
      const r = scale * (0.06 + rand() * 0.32);
      const tierY = ((i % 3) - 1) * scale * 0.2 + (rand() - 0.5) * scale * 0.1;
      const origin = new THREE.Vector3(Math.sin(a) * r, tierY, Math.cos(a) * r);
      const pitch = basePitch + (rand() - 0.5) * 0.26;
      appendCurvedSprigCard(cardBuf, {
        origin,
        yaw: a,
        pitch,
        roll: (rand() - 0.5) * 0.38,
        width: scale * cs * (1.38 + rand() * 0.46),
        length: scale * cs * (1.56 + rand() * 0.52),
        archDroop: tipArch * (0.75 + rand() * 0.5),
        cupDepth: scale * 0.16,
        flipU: rand() < 0.5,
        anchor: 'bottom',
        aoCenter,
        aoRadius: scale * 1.85,
        aoMin: 0.56,
        aoMax: 1.06,
        tint: pickTint(),
        normalTransferWeight: 0.72,
      });
    }

    // Layer 2: Angled cross-plane needle tufts for dense 3D silhouette from side & below
    const crossCount = isHigh ? habit.crossCountHigh : Math.max(3, Math.round(habit.crossCountHigh * 0.65));
    for (let i = 0; i < crossCount; i++) {
      const a = baseYaw + (i / crossCount) * Math.PI * 2 + 0.35;
      const r = scale * (0.12 + rand() * 0.3);
      const origin = new THREE.Vector3(
        Math.sin(a) * r,
        scale * (0.04 + (rand() - 0.35) * 0.26),
        Math.cos(a) * r
      );
      const pitch = THREE.MathUtils.lerp(habit.pitchLow - 0.16, habit.pitchHigh - 0.14, hFrac) + (rand() - 0.5) * 0.24;
      const roll = (i % 2 === 0 ? 1 : -1) * (0.68 + rand() * 0.35);
      appendCurvedSprigCard(cardBuf, {
        origin,
        yaw: a,
        pitch,
        roll,
        width: scale * cs * (1.24 + rand() * 0.36),
        length: scale * cs * (1.42 + rand() * 0.42),
        archDroop: tipArch * 0.65,
        cupDepth: scale * 0.12,
        flipU: rand() < 0.5,
        anchor: 'bottom',
        aoCenter,
        aoRadius: scale * 1.85,
        aoMin: 0.58,
        aoMax: 1.04,
        tint: pickTint(),
        normalTransferWeight: 0.72,
      });
    }

    // Optional Layer 3: Lacy cascading underside sprays (signature Western Red Cedar & Western Hemlock drape!)
    if (habit.drapeCountHigh && habit.drapeCountHigh > 0) {
      const dCount = isHigh ? habit.drapeCountHigh : Math.max(2, Math.round(habit.drapeCountHigh * 0.6));
      for (let i = 0; i < dCount; i++) {
        const a = baseYaw + ((i / dCount) * 2 - 1) * 1.25 + (rand() - 0.5) * 0.35;
        const r = scale * (0.28 + rand() * 0.42);
        const origin = new THREE.Vector3(Math.sin(a) * r, -scale * 0.06, Math.cos(a) * r);
        appendCurvedSprigCard(cardBuf, {
          origin,
          yaw: a,
          pitch: (habit.drapePitch ?? 0.56) + (rand() - 0.5) * 0.2,
          roll: (rand() - 0.5) * 0.4,
          width: scale * cs * (1.12 + rand() * 0.32),
          length: scale * cs * (1.25 + rand() * 0.38),
          archDroop: scale * 0.24,
          cupDepth: scale * 0.12,
          flipU: rand() < 0.5,
          anchor: 'bottom',
          aoCenter,
          aoRadius: scale * 1.9,
          aoMin: 0.54,
          aoMax: 1.0,
          tint: pickTint(),
          normalTransferWeight: 0.7,
        });
      }
    }
  } else if (ctx.speciesId === 'weeping_willow') {
    // Weeping Willow:
    // Arching crown sub-branches + lush draped crown cap + long vertical cascading chartreuse curtains!
    const archCount = 5;
    const dropAnchors: Array<{ pos: THREE.Vector3; yaw: number }> = [];
    for (let k = 0; k < archCount; k++) {
      const a = baseYaw + (k / archCount) * Math.PI * 2 + (rand() - 0.5) * 0.35;
      const len = scale * (0.58 + rand() * 0.38);
      const mid = new THREE.Vector3(Math.sin(a) * len * 0.55, scale * 0.18, Math.cos(a) * len * 0.55);
      const tip = new THREE.Vector3(Math.sin(a) * len, -scale * 0.08, Math.cos(a) * len);
      appendSubTwig(twigBuf, new THREE.Vector3(0, 0, 0), mid, scale * 0.048, scale * 0.028);
      appendSubTwig(twigBuf, mid, tip, scale * 0.028, scale * 0.012);
      dropAnchors.push({ pos: tip, yaw: a });
      dropAnchors.push({ pos: mid, yaw: a + 0.32 });
    }

    const willowAoCenter = new THREE.Vector3(0, -scale * 0.65, 0);

    // Layer 1: Gently arching upper canopy willow drapes curving smoothly over the bough shoulders
    // (hides every vertical curtain top edge so the crown silhouette is soft, rounded, and natural!)
    const capCount = isHigh ? 10 : 7;
    for (let i = 0; i < capCount; i++) {
      const a = baseYaw + (i / capCount) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      // Start tucked right near center so the arched shoulder curves seamlessly out & downward
      const r = scale * (0.04 + rand() * 0.16);
      const origin = new THREE.Vector3(
        Math.sin(a) * r,
        scale * (0.24 + rand() * 0.18),
        Math.cos(a) * r
      );
      // Pitch ~0.22..0.62 rad + strong downward archDroop creates a waterfall fountain arc!
      appendCurvedSprigCard(cardBuf, {
        origin,
        yaw: a,
        pitch: 0.24 + rand() * 0.38,
        roll: (rand() - 0.5) * 0.28,
        width: scale * (1.18 + rand() * 0.36),
        length: scale * (1.72 + rand() * 0.54),
        archDroop: scale * 0.88,
        cupDepth: scale * 0.22,
        flipU: rand() < 0.5,
        anchor: 'top',
        aoCenter: willowAoCenter,
        aoRadius: scale * 2.3,
        aoMin: 0.56,
        aoMax: 1.04,
        tint: pickTint(),
        normalTransferWeight: 0.76,
      });
    }

    // Layer 2: Long hanging vertical cascading willow curtains tucked smoothly beneath the arching shoulder!
    const curtainCount = isHigh ? 14 : 9;
    for (let i = 0; i < curtainCount; i++) {
      const anchorObj = dropAnchors[i % dropAnchors.length];
      const radialYaw = anchorObj.yaw + (rand() - 0.5) * 0.45;
      // Alternate tangential & radial curtain orientations so curtains look volumetric from every azimuth!
      const planeYaw = i % 2 === 0 ? radialYaw : radialYaw + Math.PI * 0.5;
      const jitterR = scale * 0.16;
      const origin = new THREE.Vector3(
        anchorObj.pos.x * 0.82 + (rand() - 0.5) * jitterR,
        anchorObj.pos.y - scale * (0.06 + rand() * 0.16),
        anchorObj.pos.z * 0.82 + (rand() - 0.5) * jitterR
      );
      // Pitch ≈ 1.32..1.50 rad + outward bell-curve droop seamlessly blends shoulder into vertical drapes
      const pitch = Math.PI * 0.46 + (rand() - 0.5) * 0.12;
      appendCurvedSprigCard(cardBuf, {
        origin,
        yaw: planeYaw,
        pitch,
        roll: (rand() - 0.5) * 0.16,
        width: scale * (1.16 + rand() * 0.42),
        length: scale * (2.05 + rand() * 1.02),
        archDroop: scale * (0.14 + rand() * 0.12),
        cupDepth: scale * 0.16,
        flipU: rand() < 0.5,
        anchor: 'top',
        aoCenter: willowAoCenter,
        aoRadius: scale * 2.4,
        aoMin: 0.48,
        aoMax: 1.02,
        tint: pickTint(),
        normalTransferWeight: 0.74,
      });
    }
  } else if (cfg.broadleafHabit) {
    // Species-tuned deciduous hardwood & ornamental broadleaf crown builder
    const habit = cfg.broadleafHabit;
    const cs = habit.cardScale;
    const twigCount = 5;
    const twigRadMul =
      ctx.speciesId === 'arbutus' ? 0.52 : ctx.speciesId === 'garry_oak' ? 0.62 : 1.0;
    const twigBaseY =
      ctx.speciesId === 'arbutus' || ctx.speciesId === 'garry_oak' ? -scale * 0.02 : -scale * 0.08;
    const twigAnchors: Array<{ pos: THREE.Vector3; yaw: number }> = [];
    for (let t = 0; t < twigCount; t++) {
      const a = baseYaw + (t / twigCount) * Math.PI * 2 + (rand() - 0.5) * 0.45;
      const len = scale * (0.52 + rand() * 0.36);
      const lift = scale * (0.06 + (rand() - 0.35) * 0.24);
      const end = new THREE.Vector3(Math.sin(a) * len, lift, Math.cos(a) * len);
      appendSubTwig(
        twigBuf,
        new THREE.Vector3(0, twigBaseY, 0),
        end,
        scale * 0.044 * twigRadMul,
        scale * 0.014 * twigRadMul
      );
      twigAnchors.push({ pos: end, yaw: a });

      const subA = a + (t % 2 === 0 ? 0.56 : -0.56);
      const mid = end.clone().multiplyScalar(0.54);
      const subEnd = mid
        .clone()
        .add(new THREE.Vector3(Math.sin(subA) * len * 0.5, scale * 0.1, Math.cos(subA) * len * 0.5));
      appendSubTwig(
        twigBuf,
        mid,
        subEnd,
        scale * 0.024 * twigRadMul,
        scale * 0.01 * twigRadMul
      );
      twigAnchors.push({ pos: subEnd, yaw: subA });
    }

    // Optional height-weighted bloom vs. pure-leaf interspersing (e.g. Common Lilac: greener lower limbs, rich blooms up top!)
    const bloomDist = !isDeadwood && ctx.leafOnlyMat ? habit.bloomDistribution : undefined;
    const leafOnlyCfg = bloomDist ? SPRIG_CONFIGS[bloomDist.leafOnlySprigId] : undefined;
    const baseBloomProb = bloomDist
      ? THREE.MathUtils.lerp(bloomDist.lowBloomChance, bloomDist.highBloomChance, Math.pow(hFrac, 0.92))
      : 1.0;

    // Layer 1: Primary outward & layered broadleaf sprig fans
    const horizCount = isHigh ? habit.horizCountHigh : Math.max(7, Math.round(habit.horizCountHigh * 0.65));
    const horizBloomProb = bloomDist ? THREE.MathUtils.clamp(baseBloomProb * 0.72, 0.06, 0.88) : 1.0;
    for (let i = 0; i < horizCount; i++) {
      const tier = i % 3;
      const anchorObj = twigAnchors[i % twigAnchors.length];
      const a = anchorObj.yaw + (rand() - 0.5) * 0.75;
      const radFrac = 0.22 + rand() * 0.58;
      const origin = new THREE.Vector3(
        anchorObj.pos.x * radFrac,
        (tier - 1) * scale * habit.tierSpread + (rand() - 0.5) * scale * 0.12,
        anchorObj.pos.z * radFrac
      );
      const useBloom = !bloomDist || rand() < horizBloomProb;
      const targetBuf = useBloom ? cardBuf : leafCardBuf;
      const cardTint = useBloom || !leafOnlyCfg ? pickTint() : pickTintFrom(leafOnlyCfg.tintPalette);
      const isPuff = Boolean(habit.volumetricPuff && useBloom);
      let pitch = isPuff
        ? THREE.MathUtils.lerp(-1.12, -0.34, rand())
        : THREE.MathUtils.lerp(habit.pitchMin, habit.pitchMax, rand());
      if (!isPuff && useBloom && bloomDist?.bloomPitchLift) {
        pitch += bloomDist.bloomPitchLift;
      }
      const cardW = scale * cs * (isPuff ? 1.24 + rand() * 0.40 : 1.38 + rand() * 0.48);
      const cardL = scale * cs * (isPuff ? 1.26 + rand() * 0.40 : 1.42 + rand() * 0.48);
      appendCurvedSprigCard(targetBuf, {
        origin,
        yaw: a,
        pitch,
        roll: (rand() - 0.5) * (isPuff ? 1.15 : 0.45),
        width: cardW,
        length: cardL,
        archDroop: scale * habit.archDroop * (isPuff ? 0.45 + rand() * 0.35 : 0.75 + rand() * 0.5),
        cupDepth: scale * (isPuff ? 0.24 : 0.15),
        flipU: rand() < 0.5,
        anchor: cfg.anchor,
        aoCenter,
        aoRadius: scale * 1.9,
        aoMin: isPuff ? 0.56 : 0.52,
        aoMax: 1.08,
        tint: cardTint,
        normalTransferWeight: isPuff ? 0.86 : 0.74,
      });
      // For billowing volumetric smoke clouds, pair alternating outer plumes with a steep cross-plane puff
      // so eye-level side profiles read as fluffy 3D clouds with zero flat pancake layers!
      if (isPuff && i % 2 === 0) {
        appendCurvedSprigCard(targetBuf, {
          origin: origin.clone().add(new THREE.Vector3(0, scale * 0.06, 0)),
          yaw: a + Math.PI * 0.48 + (rand() - 0.5) * 0.32,
          pitch: THREE.MathUtils.lerp(-1.32, -0.78, rand()),
          roll: (rand() - 0.5) * 0.9,
          width: cardW * 0.94,
          length: cardL * 0.96,
          archDroop: scale * 0.08,
          cupDepth: scale * 0.22,
          flipU: rand() < 0.5,
          anchor: cfg.anchor,
          aoCenter,
          aoRadius: scale * 1.9,
          aoMin: 0.58,
          aoMax: 1.08,
          tint: pickTint(),
          normalTransferWeight: 0.86,
        });
      }
    }

    // Layer 2: Upper-crown lifted dome accent sprigs for lush 3D volume from all viewing angles
    const topCount = isHigh ? habit.topCountHigh : Math.max(4, Math.round(habit.topCountHigh * 0.62));
    const topBloomProb = bloomDist ? THREE.MathUtils.clamp(baseBloomProb * 1.28, 0.14, 0.94) : 1.0;
    for (let i = 0; i < topCount; i++) {
      const a = baseYaw + (i / topCount) * Math.PI * 2 + rand() * 0.5;
      const r = scale * (0.1 + rand() * 0.34);
      const origin = new THREE.Vector3(
        Math.sin(a) * r,
        scale * (0.1 + rand() * 0.28),
        Math.cos(a) * r
      );
      const useBloom = !bloomDist || rand() < topBloomProb;
      const targetBuf = useBloom ? cardBuf : leafCardBuf;
      const cardTint = useBloom || !leafOnlyCfg ? pickTint() : pickTintFrom(leafOnlyCfg.tintPalette);
      const isPuff = Boolean(habit.volumetricPuff && useBloom);
      const pitch = isPuff
        ? THREE.MathUtils.lerp(-1.34, -0.56, rand())
        : THREE.MathUtils.lerp(habit.topPitchMin, habit.topPitchMax, rand());
      appendCurvedSprigCard(targetBuf, {
        origin,
        yaw: a,
        pitch,
        roll: (rand() - 0.5) * (isPuff ? 1.1 : 0.52),
        width: scale * cs * (isPuff ? 1.18 + rand() * 0.38 : 1.28 + rand() * 0.42),
        length: scale * cs * (isPuff ? 1.20 + rand() * 0.38 : 1.32 + rand() * 0.42),
        archDroop: scale * habit.archDroop * (isPuff ? 0.5 : 0.8),
        cupDepth: scale * (isPuff ? 0.24 : 0.16),
        flipU: rand() < 0.5,
        anchor: cfg.anchor,
        aoCenter,
        aoRadius: scale * 1.9,
        aoMin: 0.66,
        aoMax: 1.1,
        tint: cardTint,
        normalTransferWeight: isPuff ? 0.86 : 0.74,
      });
    }

    // Optional Layer 3: Pendulous hanging leaf drapes (Blue Gum Eucalyptus!)
    if (habit.drapeCountHigh && habit.drapeCountHigh > 0) {
      const dCount = isHigh ? habit.drapeCountHigh : Math.max(4, Math.round(habit.drapeCountHigh * 0.6));
      const dMul = habit.drapeLengthMul ?? 1.45;
      for (let i = 0; i < dCount; i++) {
        const anchorObj = twigAnchors[i % twigAnchors.length];
        const planeYaw = i % 2 === 0 ? anchorObj.yaw : anchorObj.yaw + Math.PI * 0.5;
        const origin = new THREE.Vector3(
          anchorObj.pos.x * 0.85 + (rand() - 0.5) * scale * 0.16,
          anchorObj.pos.y - scale * 0.04,
          anchorObj.pos.z * 0.85 + (rand() - 0.5) * scale * 0.16
        );
        appendCurvedSprigCard(cardBuf, {
          origin,
          yaw: planeYaw,
          pitch: Math.PI * 0.44 + (rand() - 0.5) * 0.18,
          roll: (rand() - 0.5) * 0.24,
          width: scale * cs * (1.12 + rand() * 0.36),
          length: scale * cs * dMul * (0.9 + rand() * 0.38),
          archDroop: scale * 0.22,
          cupDepth: scale * 0.14,
          flipU: rand() < 0.5,
          anchor: cfg.anchor,
          aoCenter,
          aoRadius: scale * 2.1,
          aoMin: 0.54,
          aoMax: 1.06,
          tint: pickTint(),
          normalTransferWeight: 0.72,
        });
      }
    }
  }

  // Emit single merged foliage sprig mesh for the entire cluster (1 draw call!)
  if (cardBuf.indices.length > 0) {
    const cardGeo = finalizeBufferGeometry(cardBuf, true);
    const cardMat = isDeadwood ? ctx.deadMat : ctx.liveMat;
    const cardMesh = new THREE.Mesh(cardGeo, cardMat);
    cardMesh.castShadow = true;
    cardMesh.receiveShadow = true;
    // Alpha-tested leaf-dappled shadow casting!
    cardMesh.customDepthMaterial = isDeadwood ? ctx.deadDepthMat : ctx.liveDepthMat;
    cardMesh.userData = { isBotanicalSprig: true };
    group.add(cardMesh);

    // Optional Pass-2 gossamer feather veil mesh (silky translucent outer smoke plumes!)
    if (!isDeadwood && ctx.liveVeilMat) {
      const veilMesh = new THREE.Mesh(cardGeo, ctx.liveVeilMat);
      veilMesh.castShadow = false;
      veilMesh.receiveShadow = false;
      veilMesh.renderOrder = 2;
      veilMesh.userData = { isBotanicalSprig: true };
      group.add(veilMesh);
    }
  }

  // Optional secondary merged leaf-only sprig mesh (used for height-weighted bloom/foliage mixing)
  if (!isDeadwood && leafCardBuf.indices.length > 0 && ctx.leafOnlyMat && ctx.leafOnlyDepthMat) {
    const leafGeo = finalizeBufferGeometry(leafCardBuf, true);
    const leafMesh = new THREE.Mesh(leafGeo, ctx.leafOnlyMat);
    leafMesh.castShadow = true;
    leafMesh.receiveShadow = true;
    leafMesh.customDepthMaterial = ctx.leafOnlyDepthMat;
    leafMesh.userData = { isBotanicalSprig: true };
    group.add(leafMesh);
  }

  // Emit single merged 2nd-order sub-twig skeleton mesh
  if (twigBuf.indices.length > 0) {
    const twigGeo = finalizeBufferGeometry(twigBuf, false);
    const twigMesh = new THREE.Mesh(twigGeo, ctx.twigMat);
    // Canopy cards cast the dappled shadow. Sub-twigs are thin, numerous, and not worth a shadow draw.
    twigMesh.castShadow = false;
    twigMesh.receiveShadow = false;
    twigMesh.userData = { isBotanicalTwig: true };
    group.add(twigMesh);
  }

  return group;
}

/**
 * Helper to create a clean tapered woody upper-crown scaffold branch connecting the trunk
 * to an outer upper-crown foliage cluster so translucent botanical canopies reveal real internal branching!
 */
export function buildCrownScaffoldLimb(
  start: THREE.Vector3,
  end: THREE.Vector3,
  rBase: number,
  rTip: number,
  mat: THREE.Material
): THREE.Mesh | null {
  const delta = new THREE.Vector3().subVectors(end, start);
  const len = delta.length();
  if (len < 0.35) return null;

  const geo = new THREE.CylinderGeometry(rTip, rBase, len, 6, 1, false);
  // Shift cylinder so base sits at origin and grows along +Y
  geo.translate(0, len * 0.5, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(start);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { isBotanicalTwig: true };
  return mesh;
}

/**
 * Builds an instancing-ready alpha-tested botanical evergreen conifer crown (for distant forest backdrop trees!)
 * using the cached Douglas Fir needle sprig texture — replaces smooth stacked cones with real feathery PNW boughs
 * in a SINGLE instanced draw call across the entire forest horizon!
 */
export function buildBackdropConiferCrownAssets(quality: GraphicsQuality): {
  geometry: THREE.BufferGeometry;
  map: THREE.Texture;
} {
  // Always use 512px mip-safe sprig texture for distant forest backdrop (fast & crisp at distance!)
  const tex = getSprigTextures('douglas_fir', 'standard');
  const buf = makeBuffer();
  const neutralTint = new THREE.Color('#ffffff');

  // Deterministic lightweight LCG so every backdrop tree has clean, balanced spiral whorls
  let seed = 48271;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const tiers = quality === 'high' ? 10 : 7;
  const aoCenter = new THREE.Vector3(0, 12.0, 0);

  for (let ti = 0; ti < tiers; ti++) {
    const f = ti / (tiers - 1); // 0 = lower wide skirt (y ~ 4.4), 1 = narrow spire tip (y ~ 21.8)
    const y = THREE.MathUtils.lerp(4.4, 21.8, f);
    const crownR = THREE.MathUtils.lerp(3.85, 0.95, Math.pow(f, 0.92));
    const cardsInTier = f > 0.82 ? 3 : f > 0.52 ? 4 : 5;

    for (let ci = 0; ci < cardsInTier; ci++) {
      const yaw = (ci / cardsInTier) * Math.PI * 2 + ti * 1.18 + (rand() - 0.5) * 0.35;
      const origin = new THREE.Vector3(
        Math.sin(yaw) * 0.22,
        y + (rand() - 0.5) * 0.55,
        Math.cos(yaw) * 0.22
      );
      const len = crownR * (0.96 + rand() * 0.28);
      const width = len * (0.98 + rand() * 0.24);
      // Authentic Cascadia Douglas Fir sweep: horizontal-to-upturned lower boughs -> sky-reaching upper boughs!
      const pitch = THREE.MathUtils.lerp(-0.06, -0.68, Math.pow(f, 1.05)) + (rand() - 0.5) * 0.16;

      appendCurvedSprigCard(buf, {
        origin,
        yaw,
        pitch,
        roll: (rand() - 0.5) * 0.38,
        width,
        length: len,
        archDroop: -len * THREE.MathUtils.lerp(0.18, 0.28, f),
        cupDepth: width * 0.12,
        flipU: rand() < 0.5,
        anchor: 'bottom',
        aoCenter,
        aoRadius: 6.5,
        aoMin: THREE.MathUtils.lerp(0.56, 0.78, f),
        aoMax: THREE.MathUtils.lerp(0.95, 1.12, f),
        tint: neutralTint,
        normalTransferWeight: 0.78,
      });
    }
  }

  // Crown spire tip crossed vertical boughs so tops taper organically to a feathery Cascadia point
  for (let s = 0; s < 3; s++) {
    const yaw = (s / 3) * Math.PI + 0.3;
    appendCurvedSprigCard(buf, {
      origin: new THREE.Vector3(0, 20.6, 0),
      yaw,
      pitch: -Math.PI * 0.46,
      roll: 0,
      width: 1.85,
      length: 3.2,
      archDroop: 0.08,
      cupDepth: 0.14,
      flipU: s % 2 === 0,
      anchor: 'bottom',
      aoCenter,
      aoRadius: 6.5,
      aoMin: 0.85,
      aoMax: 1.12,
      tint: neutralTint,
      normalTransferWeight: 0.75,
    });
  }

  return {
    geometry: finalizeBufferGeometry(buf, true),
    map: tex.map,
  };
}

