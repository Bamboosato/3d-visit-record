import { strToU8, zipSync, type Zippable } from 'fflate';
import type {
  PhotoAttachment,
  SpotCategory,
  StatusFilterValue,
  StoredPhotoRecord,
  VisitDate,
  VisitEntry,
  VisitSpot,
} from '../types/visit';
import { getStoredPhoto } from './photoStorage';
import { getSpotCategoryMeta } from './spotCategories';
import { matchesStatusFilter } from './spotDomain';
import { formatVisitDate, getVisitDateRange } from './visitDate';

export type ExportFormat = 'geojson' | 'csv' | 'kml' | 'zip';

export interface ExportFilterOptions {
  status: StatusFilterValue;
  category: SpotCategory | 'all';
}

export interface ExportTargetSummary {
  spotCount: number;
  entryCount: number;
  photoCount: number;
}

export interface ExportZipProgress {
  phase: 'preparing' | 'reading-photos' | 'packaging';
  processed: number;
  total: number;
}

export interface MissingExportPhotoInfo {
  photoId: string;
  spotId: string;
  spotName: string;
  entryId: string;
  originalFileName: string;
}

export interface ExportManifest {
  app: '3d-visit-record';
  version: string;
  exportedAt: string;
  spotCount: number;
  entryCount: number;
  totalPhotoRefs: number;
  includedPhotoCount: number;
  missingPhotoCount: number;
  missingPhotos: MissingExportPhotoInfo[];
  files: string[];
}

export interface ExportZipResult {
  blob: Blob;
  fileName: string;
  manifest: ExportManifest;
}

export const EXPORT_FORMAT_VERSION = '1.0';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildExportFileName(format: ExportFormat, date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  return `3d-visit-record_${yyyy}-${mm}-${dd}.${format}`;
}

export function filterSpotsForExport(
  spots: VisitSpot[],
  filter: ExportFilterOptions
): VisitSpot[] {
  return spots.filter((spot) => {
    if (!matchesStatusFilter(spot, filter.status)) return false;
    if (filter.category !== 'all' && spot.category !== filter.category) return false;
    return true;
  });
}

export function summarizeExportTargets(spots: VisitSpot[]): ExportTargetSummary {
  let entryCount = 0;
  let photoCount = 0;
  for (const spot of spots) {
    entryCount += spot.entries.length;
    for (const entry of spot.entries) {
      photoCount += entry.photos.length;
    }
  }
  return {
    spotCount: spots.length,
    entryCount,
    photoCount,
  };
}

export function sanitizeFileNameSegment(raw: string, maxLength = 40): string {
  const replaced = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\s_]+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '');
  if (!replaced) return 'spot';
  const truncated = Array.from(replaced).slice(0, maxLength).join('').replace(/[_.]+$/g, '');
  return truncated || 'spot';
}

export function resolvePhotoExtension(mimeType: PhotoAttachment['mimeType']): 'jpg' | 'webp' {
  return mimeType === 'image/jpeg' ? 'jpg' : 'webp';
}

export function makePhotoPathKey(spotId: string, entryId: string, photoId: string): string {
  return `${spotId}\0${entryId}\0${photoId}`;
}

function resolveDateSegment(date: VisitDate): string {
  if (date.precision === 'none' || !date.start) return 'nodate';
  return sanitizeFileNameSegment(date.start, 20);
}

export function buildPhotoFilePathMap(spots: VisitSpot[]): Map<string, string> {
  const pathMap = new Map<string, string>();
  const usedLowerPaths = new Set<string>();

  for (const spot of spots) {
    const safeSpotName = sanitizeFileNameSegment(spot.name, 40);
    for (const entry of spot.entries) {
      const dateSegment = resolveDateSegment(entry.date);
      for (const photo of entry.photos) {
        const ext = resolvePhotoExtension(photo.mimeType);
        const shortId = photo.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'photo';
        const baseName = `${dateSegment}_${safeSpotName}_${shortId}`;

        let candidate = `photos/${baseName}.${ext}`;
        let suffix = 2;
        while (usedLowerPaths.has(candidate.toLowerCase())) {
          candidate = `photos/${baseName}-${suffix}.${ext}`;
          suffix++;
        }

        usedLowerPaths.add(candidate.toLowerCase());
        pathMap.set(makePhotoPathKey(spot.id, entry.id, photo.id), candidate);
      }
    }
  }

  return pathMap;
}

function resolveEntryPhotoFiles(
  spotId: string,
  entry: VisitEntry,
  photoPathMap: Map<string, string>
): string[] {
  return entry.photos.map(
    (photo) => photoPathMap.get(makePhotoPathKey(spotId, entry.id, photo.id)) ?? photo.fileName
  );
}

function resolveLatestSpotDate(entries: VisitEntry[]): string | null {
  let bestSortKey = '';
  let bestValue: string | null = null;

  for (const entry of entries) {
    const range = getVisitDateRange(entry.date);
    if (!range) continue;
    const candidate = entry.date.end ?? entry.date.start ?? null;
    if (candidate && range.end > bestSortKey) {
      bestSortKey = range.end;
      bestValue = candidate;
    }
  }

  return bestValue;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: {
      type: 'Point';
      coordinates: [number, number] | [number, number, number];
    };
    properties: {
      id: string;
      name: string;
      status: VisitSpot['status'];
      category: VisitSpot['category'];
      categoryLabel: string;
      elevation: number | null;
      addressSummary: string | null;
      presetId: string | null;
      isPinned: boolean;
      entryCount: number;
      photoCount: number;
      latestDate: string | null;
      createdAt: string;
      updatedAt: string;
      entries: Array<{
        id: string;
        kind: VisitEntry['kind'];
        date: VisitDate;
        dateLabel: string;
        memo: string;
        photoCount: number;
        photoFiles: string[];
      }>;
    };
  }>;
}

export function buildGeoJsonObject(
  spots: VisitSpot[],
  photoPathMap?: Map<string, string>
): GeoJsonFeatureCollection {
  const resolvedPaths = photoPathMap ?? buildPhotoFilePathMap(spots);

  return {
    type: 'FeatureCollection',
    features: spots.map((spot) => {
      const [lng, lat] = spot.center;
      const coordinates: [number, number] | [number, number, number] =
        spot.elevation !== null && Number.isFinite(spot.elevation)
          ? [lng, lat, spot.elevation]
          : [lng, lat];

      let photoCount = 0;
      const entries = spot.entries.map((entry) => {
        photoCount += entry.photos.length;
        return {
          id: entry.id,
          kind: entry.kind,
          date: { ...entry.date },
          dateLabel: formatVisitDate(entry.date),
          memo: entry.memo,
          photoCount: entry.photos.length,
          photoFiles: resolveEntryPhotoFiles(spot.id, entry, resolvedPaths),
        };
      });

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates,
        },
        properties: {
          id: spot.id,
          name: spot.name,
          status: spot.status,
          category: spot.category,
          categoryLabel: getSpotCategoryMeta(spot.category).label,
          elevation: spot.elevation,
          addressSummary: spot.addressSummary ?? null,
          presetId: spot.presetId ?? null,
          isPinned: spot.isPinned,
          entryCount: spot.entries.length,
          photoCount,
          latestDate: resolveLatestSpotDate(spot.entries),
          createdAt: spot.createdAt,
          updatedAt: spot.updatedAt,
          entries,
        },
      };
    }),
  };
}

export function generateGeoJson(
  spots: VisitSpot[],
  photoPathMap?: Map<string, string>
): string {
  return JSON.stringify(buildGeoJsonObject(spots, photoPathMap), null, 2);
}

const CSV_HEADERS = [
  'spotId',
  'name',
  'status',
  'category',
  'lat',
  'lng',
  'elevation',
  'addressSummary',
  'entryId',
  'entryKind',
  'dateStart',
  'dateEnd',
  'datePrecision',
  'memo',
  'photoCount',
  'photoFiles',
] as const;

export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateCsv(
  spots: VisitSpot[],
  photoPathMap?: Map<string, string>
): string {
  const resolvedPaths = photoPathMap ?? buildPhotoFilePathMap(spots);
  const rows: string[] = [CSV_HEADERS.join(',')];

  for (const spot of spots) {
    const [lng, lat] = spot.center;
    const elevation =
      spot.elevation !== null && Number.isFinite(spot.elevation) ? String(spot.elevation) : '';
    const baseColumns = [
      spot.id,
      spot.name,
      spot.status,
      spot.category,
      String(lat),
      String(lng),
      elevation,
      spot.addressSummary ?? '',
    ];

    if (spot.entries.length === 0) {
      const row = [...baseColumns, '', '', '', '', '', '', '0', ''].map(escapeCsvField);
      rows.push(row.join(','));
      continue;
    }

    for (const entry of spot.entries) {
      const photoFiles = resolveEntryPhotoFiles(spot.id, entry, resolvedPaths).join('; ');
      const row = [
        ...baseColumns,
        entry.id,
        entry.kind,
        entry.date.start ?? '',
        entry.date.end ?? '',
        entry.date.precision,
        entry.memo,
        String(entry.photos.length),
        photoFiles,
      ].map(escapeCsvField);
      rows.push(row.join(','));
    }
  }

  return `\uFEFF${rows.join('\r\n')}`;
}

export function escapeXml(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

function buildPlacemarkDescription(spot: VisitSpot): string {
  const lines: string[] = [];
  const statusLabel = spot.status === 'visited' ? '訪問済み' : '訪問予定';
  const categoryLabel = getSpotCategoryMeta(spot.category).label;
  lines.push(`ステータス: ${statusLabel} / カテゴリ: ${categoryLabel}`);
  if (spot.elevation !== null && Number.isFinite(spot.elevation)) {
    lines.push(`標高: ${spot.elevation} m`);
  }
  if (spot.addressSummary) {
    lines.push(`場所: ${spot.addressSummary}`);
  }
  if (spot.entries.length > 0) {
    lines.push('');
    lines.push(`記録 (${spot.entries.length}件):`);
    for (const entry of spot.entries) {
      const kindLabel = entry.kind === 'visited' ? '訪問' : '予定';
      const dateLabel = formatVisitDate(entry.date);
      const photoNote = entry.photos.length > 0 ? ` [写真${entry.photos.length}枚]` : '';
      lines.push(`- [${kindLabel}] ${dateLabel}${photoNote}`);
      if (entry.memo) {
        lines.push(`  ${entry.memo}`);
      }
    }
  }
  return lines.join('\n');
}

function renderPlacemarkXml(spot: VisitSpot): string {
  const [lng, lat] = spot.center;
  const coords =
    spot.elevation !== null && Number.isFinite(spot.elevation)
      ? `${lng},${lat},${spot.elevation}`
      : `${lng},${lat}`;
  const description = buildPlacemarkDescription(spot);

  const extendedDataEntries: Array<[string, string]> = [
    ['spotId', spot.id],
    ['status', spot.status],
    ['category', spot.category],
  ];
  if (spot.elevation !== null && Number.isFinite(spot.elevation)) {
    extendedDataEntries.push(['elevation', String(spot.elevation)]);
  }
  if (spot.addressSummary) {
    extendedDataEntries.push(['addressSummary', spot.addressSummary]);
  }

  const extendedDataXml = extendedDataEntries
    .map(
      ([k, v]) =>
        `        <Data name="${escapeXml(k)}"><value>${escapeXml(v)}</value></Data>`
    )
    .join('\n');

  return [
    '      <Placemark>',
    `        <name>${escapeXml(spot.name)}</name>`,
    `        <styleUrl>#style-${spot.status}</styleUrl>`,
    `        <description>${escapeXml(description)}</description>`,
    '        <ExtendedData>',
    extendedDataXml,
    '        </ExtendedData>',
    '        <Point>',
    `          <coordinates>${coords}</coordinates>`,
    '        </Point>',
    '      </Placemark>',
  ].join('\n');
}

export function generateKml(spots: VisitSpot[]): string {
  const visitedSpots = spots.filter((s) => s.status === 'visited');
  const plannedSpots = spots.filter((s) => s.status === 'planned');

  const folders: string[] = [];
  if (visitedSpots.length > 0) {
    folders.push(
      [
        '    <Folder>',
        `      <name>${escapeXml('訪問済み')}</name>`,
        visitedSpots.map(renderPlacemarkXml).join('\n'),
        '    </Folder>',
      ].join('\n')
    );
  }
  if (plannedSpots.length > 0) {
    folders.push(
      [
        '    <Folder>',
        `      <name>${escapeXml('訪問予定')}</name>`,
        plannedSpots.map(renderPlacemarkXml).join('\n'),
        '    </Folder>',
      ].join('\n')
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    '    <name>3D Visit Record</name>',
    '    <Style id="style-visited">',
    '      <IconStyle>',
    '        <color>ff699605</color>',
    '        <scale>1.1</scale>',
    '      </IconStyle>',
    '    </Style>',
    '    <Style id="style-planned">',
    '      <IconStyle>',
    '        <color>ff0b9ef5</color>',
    '        <scale>1.1</scale>',
    '      </IconStyle>',
    '    </Style>',
    ...folders,
    '  </Document>',
    '</kml>',
  ].join('\n');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error('エクスポートが中断されました。');
  err.name = 'AbortError';
  throw err;
}

export async function buildExportZipArchive(
  spots: VisitSpot[],
  options?: {
    exportedAt?: Date;
    getPhoto?: (photoId: string) => Promise<StoredPhotoRecord | null>;
    onProgress?: (progress: ExportZipProgress) => void;
    signal?: AbortSignal;
  }
): Promise<ExportZipResult> {
  const exportedAt = options?.exportedAt ?? new Date();
  const getPhoto = options?.getPhoto ?? getStoredPhoto;
  const signal = options?.signal;
  const onProgress = options?.onProgress;

  throwIfAborted(signal);

  const summary = summarizeExportTargets(spots);
  const photoPathMap = buildPhotoFilePathMap(spots);

  const photoTasks: Array<{
    spot: VisitSpot;
    entry: VisitEntry;
    photo: PhotoAttachment;
    zipPath: string;
  }> = [];

  for (const spot of spots) {
    for (const entry of spot.entries) {
      for (const photo of entry.photos) {
        const zipPath = photoPathMap.get(makePhotoPathKey(spot.id, entry.id, photo.id));
        if (zipPath) {
          photoTasks.push({ spot, entry, photo, zipPath });
        }
      }
    }
  }

  const total = photoTasks.length;
  onProgress?.({ phase: 'preparing', processed: 0, total });

  const zipEntries: Zippable = {
    'visits.geojson': [strToU8(generateGeoJson(spots, photoPathMap)), { level: 6 }],
    'visits.csv': [strToU8(generateCsv(spots, photoPathMap)), { level: 6 }],
    'visits.kml': [strToU8(generateKml(spots)), { level: 6 }],
  };

  const missingPhotos: MissingExportPhotoInfo[] = [];
  let includedPhotoCount = 0;

  for (let i = 0; i < photoTasks.length; i++) {
    throwIfAborted(signal);
    const task = photoTasks[i];

    let record: StoredPhotoRecord | null = null;
    try {
      record = await getPhoto(task.photo.id);
    } catch {
      record = null;
    }

    throwIfAborted(signal);

    if (record && record.fullBlob && record.fullBlob.size > 0) {
      const buffer = await record.fullBlob.arrayBuffer();
      throwIfAborted(signal);
      // 圧縮済み画像（WebP / JPEG）のため STORE（無圧縮 level: 0）でパッキング
      zipEntries[task.zipPath] = [new Uint8Array(buffer), { level: 0 }];
      includedPhotoCount++;
    } else {
      missingPhotos.push({
        photoId: task.photo.id,
        spotId: task.spot.id,
        spotName: task.spot.name,
        entryId: task.entry.id,
        originalFileName: task.photo.fileName,
      });
    }

    onProgress?.({
      phase: 'reading-photos',
      processed: i + 1,
      total,
    });
  }

  throwIfAborted(signal);
  onProgress?.({ phase: 'packaging', processed: total, total });

  const fileList = ['manifest.json', ...Object.keys(zipEntries)];
  const manifest: ExportManifest = {
    app: '3d-visit-record',
    version: EXPORT_FORMAT_VERSION,
    exportedAt: exportedAt.toISOString(),
    spotCount: summary.spotCount,
    entryCount: summary.entryCount,
    totalPhotoRefs: summary.photoCount,
    includedPhotoCount,
    missingPhotoCount: missingPhotos.length,
    missingPhotos,
    files: fileList,
  };

  zipEntries['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];

  const zipped = zipSync(zipEntries);
  const blob = new Blob([new Uint8Array(zipped)], { type: 'application/zip' });

  return {
    blob,
    fileName: buildExportFileName('zip', exportedAt),
    manifest,
  };
}

export function triggerBlobDownload(
  blob: Blob,
  fileName: string,
  revokeDelayMs = 10_000
): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
  }
}
