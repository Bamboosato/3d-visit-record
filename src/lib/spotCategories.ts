import type { ComponentType } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { MountainSnow, Camera, Home, Star, type LucideProps } from 'lucide-react';
import type { SpotCategory, SpotStatus } from '../types/visit';

export interface SpotCategoryMeta {
  id: SpotCategory;
  label: string;
  icon: ComponentType<LucideProps>;
  activeBgClass: string;
  badgeBgClass: string;
  solidColor: string;
  ringColor: string;
  emoji: string;
  svgPaths: string[];
}

export const SPOT_CATEGORIES: Record<SpotCategory, SpotCategoryMeta> = {
  nature: {
    id: 'nature',
    label: '自然',
    icon: MountainSnow,
    activeBgClass: 'bg-emerald-600 border-emerald-400 text-white shadow-emerald-500/30',
    badgeBgClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    solidColor: '#059669',
    ringColor: '#34d399',
    emoji: '🌲',
    svgPaths: [
      'M8 3 L12 11 L17 6 L22 21 H2 L8 3 Z',
      'M4.14 15.08 C6.76 13.51 9.38 13.65 12 15.5 C14.74 17.44 17.49 17.5 20.23 15.69',
    ],
  },
  tourism: {
    id: 'tourism',
    label: '観光',
    icon: Camera,
    activeBgClass: 'bg-amber-600 border-amber-400 text-white shadow-amber-500/30',
    badgeBgClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    solidColor: '#d97706',
    ringColor: '#fbbf24',
    emoji: '📸',
    svgPaths: [
      'M14.5 4 h-5 L7 7 H4 a2 2 0 0 0 -2 2 v9 a2 2 0 0 0 2 2 h16 a2 2 0 0 0 2 -2 V9 a2 2 0 0 0 -2 -2 h-3 l-2.5 -3 z',
      'M15 13 A3 3 0 1 1 9 13 A3 3 0 1 1 15 13 Z',
    ],
  },
  lifestyle: {
    id: 'lifestyle',
    label: '生活',
    icon: Home,
    activeBgClass: 'bg-indigo-600 border-indigo-400 text-white shadow-indigo-500/30',
    badgeBgClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
    solidColor: '#4f46e5',
    ringColor: '#818cf8',
    emoji: '🏠',
    svgPaths: [
      'M3 9 L12 2 L21 9 V20 A2 2 0 0 1 19 22 H5 A2 2 0 0 1 3 20 Z',
      'M9 22 V12 H15 V22',
    ],
  },
  other: {
    id: 'other',
    label: 'その他',
    icon: Star,
    activeBgClass: 'bg-slate-600 border-slate-400 text-white shadow-slate-500/30',
    badgeBgClass: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
    solidColor: '#475569',
    ringColor: '#94a3b8',
    emoji: '⭐',
    svgPaths: [
      'M12 2 L15.09 8.26 L22 9.27 L17 14.14 L18.18 21.02 L12 17.77 L5.82 21.02 L7 14.14 L2 9.27 L8.91 8.26 Z',
    ],
  },
};

export const SPOT_CATEGORY_KEYS: SpotCategory[] = ['nature', 'tourism', 'lifestyle', 'other'];
export const SPOT_CATEGORY_LIST: SpotCategoryMeta[] = SPOT_CATEGORY_KEYS.map(
  (key) => SPOT_CATEGORIES[key]
);

export function isSpotCategory(val: unknown): val is SpotCategory {
  return typeof val === 'string' && val in SPOT_CATEGORIES;
}

export function getSpotCategoryMeta(category?: unknown): SpotCategoryMeta {
  if (isSpotCategory(category)) return SPOT_CATEGORIES[category];
  return SPOT_CATEGORIES.other;
}

export function getSpotSpriteId(
  category: SpotCategory,
  status: SpotStatus,
  hasUpcomingPlan = false
): string {
  if (status === 'planned') return `spot-planned-${category}`;
  if (hasUpcomingPlan) return `spot-visited-plan-${category}`;
  return `spot-visited-${category}`;
}

function drawPinSprite(
  category: SpotCategoryMeta,
  mode: 'visited' | 'visited-plan' | 'planned'
): { width: number; height: number; data: Uint8ClampedArray } {
  const size = 64; // rendered at pixelRatio: 2 -> 32x32 CSS px
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = 24;

  // Shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = mode === 'planned' ? 'rgba(15, 23, 42, 0.92)' : category.solidColor;
  ctx.fill();
  ctx.restore();

  // Outer border: solid for visited, dashed for planned
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  if (mode === 'planned') {
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = category.ringColor;
  } else {
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#f8fafc';
  }
  ctx.stroke();
  ctx.restore();

  // Inner Lucide-style vector icon (scaled from 24x24 viewBox to ~24x24 centered)
  ctx.save();
  const iconScale = 1.05;
  ctx.translate(cx - 12 * iconScale, cy - 12 * iconScale);
  ctx.scale(iconScale, iconScale);
  ctx.strokeStyle = mode === 'planned' ? category.ringColor : '#ffffff';
  ctx.lineWidth = 2.1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (typeof Path2D !== 'undefined') {
    for (const d of category.svgPaths) {
      ctx.stroke(new Path2D(d));
    }
  } else {
    ctx.beginPath();
    ctx.arc(12, 12, 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Corner badge for visited spot with upcoming plan
  if (mode === 'visited-plan') {
    ctx.save();
    ctx.beginPath();
    ctx.arc(size - 13, 13, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
    ctx.restore();
  }

  const imageData = ctx.getImageData(0, 0, size, size);
  return { width: size, height: size, data: imageData.data };
}

export function registerSpotSprites(map: maplibregl.Map): void {
  const modes: Array<'visited' | 'visited-plan' | 'planned'> = [
    'visited',
    'visited-plan',
    'planned',
  ];
  for (const cat of SPOT_CATEGORY_LIST) {
    for (const mode of modes) {
      const id =
        mode === 'planned'
          ? `spot-planned-${cat.id}`
          : mode === 'visited-plan'
            ? `spot-visited-plan-${cat.id}`
            : `spot-visited-${cat.id}`;
      if (map.hasImage(id)) continue;
      const sprite = drawPinSprite(cat, mode);
      map.addImage(
        id,
        {
          width: sprite.width,
          height: sprite.height,
          data: sprite.data,
        },
        { pixelRatio: 2 }
      );
    }
  }
}
