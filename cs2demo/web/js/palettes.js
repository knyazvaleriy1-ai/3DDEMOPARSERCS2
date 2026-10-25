// Per-map colour schemes for the untextured collision geometry. Colours are
// picked to resemble each map's dominant materials; patterns are procedural.
//
// wallPattern: 0 plaster, 1 bricks, 2 stone blocks, 3 concrete panels
// floorTile:   tile size in units (0 = no tiles, just noise)

const BASE = {
  wall: '#cdbf9f', wall2: '#bfa585', ground: '#a99a80', roof: '#b3a58c', roofAlt: '#9a6a4f', roofAltFrac: 0,
  ceiling: '#8a8176', accent: '#5f8fb0',
  skyTop: '#6f9fd6', skyHorizon: '#dfe6ea', sun: '#fff1d6', sunDir: [0.45, 0.8, 0.35],
  wallPattern: 0, wallBlock: [48, 24], floorTile: 48, grout: 0.18, alt: 0.35,
};

export const PALETTES = {
  de_mirage: {
    wall: '#e6dbc2', wall2: '#d6c19c', ground: '#cdbf9f', roof: '#d2c3a2', roofAlt: '#ad7356', roofAltFrac: 0.22,
    accent: '#3f7fa6',
    skyTop: '#5f95d6', skyHorizon: '#f1e6cf', wallPattern: 2, wallBlock: [40, 20], floorTile: 40, grout: 0.16,
  },
  de_dust2: {
    wall: '#e3c690', wall2: '#d2b07a', ground: '#d8bb85', roof: '#cfb07c', roofAlt: '#b07b52', roofAltFrac: 0.2,
    accent: '#4f7d9a',
    skyTop: '#5c97e0', skyHorizon: '#f5e6c4', sunDir: [0.3, 0.85, 0.45], wallPattern: 2, wallBlock: [56, 28],
    floorTile: 0, grout: 0.1,
  },
  de_inferno: {
    wall: '#e8d8bc', wall2: '#d8b896', ground: '#a3937c', roof: '#a8644a', roofAlt: '#c08a62', roofAltFrac: 0.35,
    accent: '#5f8a4a',
    skyTop: '#6a9ad8', skyHorizon: '#f3e3c6', wallPattern: 0, floorTile: 20, grout: 0.22, alt: 0.3,
  },
  de_nuke: {
    wall: '#cfd3d6', wall2: '#9fb0be', ground: '#8f979d', roof: '#7c8a96', ceiling: '#5d646a', accent: '#d9a43a',
    skyTop: '#86b3e2', skyHorizon: '#e7eef3', wallPattern: 3, wallBlock: [128, 64], floorTile: 128, grout: 0.12,
  },
  de_overpass: {
    wall: '#bdbbb1', wall2: '#93a088', ground: '#8e8b80', roof: '#7d7063', accent: '#4f8a7a',
    skyTop: '#7fb0de', skyHorizon: '#e6e9e4', wallPattern: 3, wallBlock: [96, 48], floorTile: 64, grout: 0.1,
  },
  de_vertigo: {
    wall: '#c4c7c8', wall2: '#d39a3e', ground: '#8e9396', roof: '#a3a9ad', accent: '#2f6fb0',
    skyTop: '#5f9fe6', skyHorizon: '#e1ebf4', wallPattern: 3, wallBlock: [128, 64], floorTile: 64, grout: 0.12,
    alt: 0.2,
  },
  de_ancient: {
    wall: '#a29f84', wall2: '#7f8b66', ground: '#7d7662', roof: '#6c7c52', accent: '#c9a24a',
    skyTop: '#7fa8c4', skyHorizon: '#d7e0d2', wallPattern: 2, wallBlock: [44, 22], floorTile: 36, grout: 0.2,
  },
  de_ancient_night: {
    wall: '#6f7280', wall2: '#59665a', ground: '#55575e', roof: '#4f5a48', accent: '#c9a24a',
    skyTop: '#141c33', skyHorizon: '#3a4660', sun: '#b9c6ff', sunDir: [-0.4, 0.75, 0.3], wallPattern: 2,
    wallBlock: [44, 22], floorTile: 36, grout: 0.2,
  },
  de_anubis: {
    wall: '#e0cb9c', wall2: '#c9af7f', ground: '#cdb383', roof: '#cdb88c', roofAlt: '#3f8f8a', roofAltFrac: 0.25,
    accent: '#2f8f8a',
    skyTop: '#5f9be2', skyHorizon: '#f4e8cb', wallPattern: 2, wallBlock: [52, 26], floorTile: 52, grout: 0.14,
  },
  de_train: {
    wall: '#b6b0a4', wall2: '#8f6c57', ground: '#7f7d77', roof: '#6d7276', accent: '#a83a32',
    skyTop: '#94b4d2', skyHorizon: '#e4e7e7', wallPattern: 1, wallBlock: [28, 12], floorTile: 64, grout: 0.12,
  },
  de_cache: {
    wall: '#c1c0b7', wall2: '#8e9a7f', ground: '#86857d', roof: '#7a7d78', accent: '#c25a2f',
    skyTop: '#8ab4dc', skyHorizon: '#e5e8e6', wallPattern: 3, wallBlock: [96, 48], floorTile: 96, grout: 0.1,
  },
  cs_office: {
    wall: '#d8d5cd', wall2: '#a9b0b6', ground: '#6f6c66', roof: '#e8ecef', ceiling: '#bfc0bf', accent: '#3f6f9f',
    skyTop: '#9fb3c6', skyHorizon: '#eef1f3', sun: '#f4f6ff', wallPattern: 3, wallBlock: [64, 128], floorTile: 32,
    grout: 0.08,
  },
  cs_italy: {
    wall: '#e6d2b2', wall2: '#d5ab8a', ground: '#9c8b78', roof: '#b4664a', roofAlt: '#c69068', roofAltFrac: 0.3,
    accent: '#4f7f4a',
    skyTop: '#6699d9', skyHorizon: '#f3e2c4', wallPattern: 0, floorTile: 18, grout: 0.24,
  },
};

const DEFAULT = { ...BASE };

export function paletteFor(mapName) {
  const name = (mapName || '').toLowerCase();
  const exact = PALETTES[name];
  if (exact) return { ...BASE, ...exact };
  // Variants such as "de_dust2_night" or workshop copies share a base map's look.
  const key = Object.keys(PALETTES).find((k) => name.startsWith(k));
  return key ? { ...BASE, ...PALETTES[key] } : DEFAULT;
}
