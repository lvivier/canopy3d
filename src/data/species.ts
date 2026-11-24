import { SpeciesId, SpeciesSpec } from '../types';

export const PNW_SPECIES: Record<SpeciesId, SpeciesSpec> = {
  douglas_fir: {
    id: 'douglas_fir',
    name: 'Douglas Fir',
    latinName: 'Pseudotsuga menziesii',
    category: 'conifer',
    description:
      'Iconic Cascadia giant with deeply furrowed reddish-brown bark, towering straight trunk, and rich emerald needle sprays.',
    arboristTip:
      'Strong, predictable hinge wood. Aim for a 30% face notch and leave a 10% holding hinge for pinpoint directional felling.',
    barkPrimary: '#4c3426',
    barkSecondary: '#2d1c13',
    barkStyle: 'furrowed',
    heartwoodColor: '#c9885b',
    sapwoodColor: '#ead3b0',
    foliageColors: ['#214a2c', '#2a5a34', '#1b3e24', '#33683b'],
    woodDensity: 1.0,
    timberValuePerMeter: 45,
    heightRange: [18, 32],
    radiusRatio: 0.025,
    buttressFlare: 1.25,
    crownShape: 'spire',
  },

  western_red_cedar: {
    id: 'western_red_cedar',
    name: 'Western Red Cedar',
    latinName: 'Thuja plicata',
    category: 'conifer',
    description:
      'Beloved coastal conifer with fibrous cinnamon-red strip bark, wide fluted buttresses, and sweeping lacy scale-leaf boughs.',
    arboristTip:
      'Soft, aromatic wood cuts very fast—ease off before over-cutting your hinge! Prune heavy drooping boughs to shift lean.',
    barkPrimary: '#6d3f2b',
    barkSecondary: '#472719',
    barkStyle: 'fibrous',
    heartwoodColor: '#a85739',
    sapwoodColor: '#e9d6b8',
    foliageColors: ['#2d5730', '#3a6835', '#244727', '#4a763a'],
    woodDensity: 0.72,
    timberValuePerMeter: 62,
    heightRange: [16, 28],
    radiusRatio: 0.032,
    buttressFlare: 1.55,
    crownShape: 'sweeping_cone',
  },

  sitka_spruce: {
    id: 'sitka_spruce',
    name: 'Sitka Spruce',
    latinName: 'Picea sitchensis',
    category: 'conifer',
    description:
      'Salt-mist coastal titan with scaly purplish-gray bark, stiff blue-green tiered foliage, and dense lower deadwood.',
    arboristTip:
      'Coastal winds often push a heavy lean into Sitka crowns. Trim windward limbs and keep wedges handy for back-lean.',
    barkPrimary: '#564d4e',
    barkSecondary: '#3b3336',
    barkStyle: 'scaly',
    heartwoodColor: '#e2cba5',
    sapwoodColor: '#f3e7cf',
    foliageColors: ['#264d47', '#2f5f57', '#1f3e3b', '#3b6e62'],
    woodDensity: 0.9,
    timberValuePerMeter: 50,
    heightRange: [16, 27],
    radiusRatio: 0.028,
    buttressFlare: 1.38,
    crownShape: 'tiered_spruce',
  },

  bigleaf_maple: {
    id: 'bigleaf_maple',
    name: 'Bigleaf Maple',
    latinName: 'Acer macrophyllum',
    category: 'deciduous',
    description:
      'Sprawling PNW hardwood draped in velvety moss, bearing huge chartreuse-to-golden leaves and heavy spreading limbs.',
    arboristTip:
      'Dense hardwood saws slowly. Heavy eccentric limbs create strong side-pull—prune them first to rebalance the canopy!',
    barkPrimary: '#5c584a',
    barkSecondary: '#455939',
    barkStyle: 'mossy',
    heartwoodColor: '#cfa77b',
    sapwoodColor: '#efe1c9',
    foliageColors: ['#6e8c33', '#8ca438', '#b89f38', '#527328'],
    woodDensity: 1.35,
    timberValuePerMeter: 55,
    heightRange: [13, 21],
    radiusRatio: 0.036,
    buttressFlare: 1.4,
    crownShape: 'broad_dome',
  },

  red_alder: {
    id: 'red_alder',
    name: 'Red Alder',
    latinName: 'Alnus rubra',
    category: 'deciduous',
    description:
      'Creekside pioneer with smooth pale gray lichen-mottled bark, bright green oval leaves, and wood that blushes orange-red when cut.',
    arboristTip:
      'Light, supple wood that saws swiftly. Great for learning directional felling, but watch for brittle hinge snap if over-cut.',
    barkPrimary: '#868781',
    barkSecondary: '#5f675e',
    barkStyle: 'smooth_lichen',
    heartwoodColor: '#d17b54',
    sapwoodColor: '#ecc3a4',
    foliageColors: ['#447c35', '#558e3f', '#38692c', '#689e47'],
    woodDensity: 0.78,
    timberValuePerMeter: 34,
    heightRange: [12, 18],
    radiusRatio: 0.024,
    buttressFlare: 1.15,
    crownShape: 'oval_upright',
  },

  western_hemlock: {
    id: 'western_hemlock',
    name: 'Western Hemlock',
    latinName: 'Tsuga heterophylla',
    category: 'conifer',
    description:
      'Graceful shade-tolerant conifer recognized by its slender russet trunk, feathery drooping boughs, and nodding leader tip.',
    arboristTip:
      'Tall and slender—very responsive to wind gusts. Lock a crisp notch and finish the back cut decisively between gusts.',
    barkPrimary: '#583b31',
    barkSecondary: '#36231d',
    barkStyle: 'plated',
    heartwoodColor: '#d8b996',
    sapwoodColor: '#eee0cc',
    foliageColors: ['#2a5732', '#35693d', '#204527', '#427846'],
    woodDensity: 0.95,
    timberValuePerMeter: 42,
    heightRange: [17, 26],
    radiusRatio: 0.021,
    buttressFlare: 1.18,
    droopingLeader: true,
    crownShape: 'graceful_feathery',
  },
};

export const SPECIES_LIST: SpeciesSpec[] = Object.values(PNW_SPECIES);
