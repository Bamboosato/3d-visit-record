import { Blob as NodeBlob } from 'node:buffer';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  buildExportFileName,
  buildExportZipArchive,
  buildGeoJsonObject,
  buildPhotoFilePathMap,
  filterSpotsForExport,
  generateCsv,
  generateGeoJson,
  generateKml,
  sanitizeFileNameSegment,
  type ExportManifest,
} from '../src/lib/exportData';
import type { PhotoAttachment, StoredPhotoRecord, VisitSpot } from '../src/types/visit';

function makePhoto(id: string, overrides: Partial<PhotoAttachment> = {}): PhotoAttachment {
  return {
    id,
    fileName: `${id}.webp`,
    mimeType: 'image/webp',
    width: 1600,
    height: 1200,
    bytes: 128,
    ...overrides,
  };
}

function makeStoredPhoto(id: string, content: string, mimeType: 'image/webp' | 'image/jpeg' = 'image/webp'): StoredPhotoRecord {
  const fullBlob = new NodeBlob([content], { type: mimeType }) as unknown as Blob;
  const thumbnailBlob = new NodeBlob(['thumb-' + content], { type: mimeType }) as unknown as Blob;
  return {
    id,
    mimeType,
    width: 1600,
    height: 1200,
    bytes: fullBlob.size,
    fullBlob,
    thumbnailBlob,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };
}

function makeSampleSpots(): VisitSpot[] {
  return [
    {
      id: 'spot-1',
      name: 'Mt. Fuji / 富士山 <Main>',
      status: 'visited',
      category: 'nature',
      center: [138.7274, 35.3606],
      elevation: 3776,
      camera: { zoom: 12, pitch: 55, bearing: 0 },
      addressSummary: '山梨県・静岡県',
      presetId: 'fuji',
      isPinned: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      entries: [
        {
          id: 'entry-1',
          kind: 'visited',
          date: { precision: 'day', start: '2026-07-15' },
          memo: '山頂で"ご来光", 風強い\n寒かった & 最高',
          photos: [
            makePhoto('sharedid1-aaa'),
            makePhoto('sharedid1-bbb', { mimeType: 'image/jpeg', fileName: 'sunrise.jpg' }),
          ],
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
        },
        {
          id: 'entry-2',
          kind: 'planned',
          date: { precision: 'month', start: '2027-07', end: '2027-08' },
          memo: '来年また行く',
          photos: [],
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    },
    {
      id: 'spot-2',
      name: 'A&B "Cafe"',
      status: 'planned',
      category: 'lifestyle',
      center: [139.7671, 35.6812],
      elevation: null,
      camera: { zoom: 14, pitch: 45, bearing: 10 },
      addressSummary: "Chiyoda's <Station>",
      isPinned: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      entries: [],
    },
  ];
}

function findZipCompressionMethod(zipBytes: Uint8Array, targetFileName: string): number | null {
  const nameBytes = new TextEncoder().encode(targetFileName);
  for (let i = 0; i <= zipBytes.length - 30 - nameBytes.length; i++) {
    // Local file header signature PK\x03\x04
    if (
      zipBytes[i] === 0x50 &&
      zipBytes[i + 1] === 0x4b &&
      zipBytes[i + 2] === 0x03 &&
      zipBytes[i + 3] === 0x04
    ) {
      const nameLen = zipBytes[i + 26] | (zipBytes[i + 27] << 8);
      if (nameLen === nameBytes.length) {
        let matched = true;
        for (let j = 0; j < nameLen; j++) {
          if (zipBytes[i + 30 + j] !== nameBytes[j]) {
            matched = false;
            break;
          }
        }
        if (matched) {
          return zipBytes[i + 8] | (zipBytes[i + 9] << 8);
        }
      }
    }
  }
  return null;
}

describe('exportData generators', () => {
  it('generates valid GeoJSON with [lng, lat(, elevation)] coordinates and spot properties', () => {
    const spots = makeSampleSpots();
    const parsed = JSON.parse(generateGeoJson(spots));

    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features).toHaveLength(2);

    const f1 = parsed.features[0];
    expect(f1.geometry).toEqual({
      type: 'Point',
      coordinates: [138.7274, 35.3606, 3776],
    });
    expect(f1.properties).toMatchObject({
      id: 'spot-1',
      name: 'Mt. Fuji / 富士山 <Main>',
      status: 'visited',
      category: 'nature',
      addressSummary: '山梨県・静岡県',
      presetId: 'fuji',
      isPinned: true,
      entryCount: 2,
      photoCount: 2,
      latestDate: '2027-08',
    });
    expect(f1.properties.entries).toHaveLength(2);
    expect(f1.properties.entries[0].photoFiles).toHaveLength(2);

    const f2 = parsed.features[1];
    expect(f2.geometry).toEqual({
      type: 'Point',
      coordinates: [139.7671, 35.6812],
    });
    expect(f2.properties.entryCount).toBe(0);
    expect(f2.properties.latestDate).toBeNull();

    expect(buildGeoJsonObject(spots).features).toHaveLength(2);
  });

  it('generates RFC 4180 CSV with UTF-8 BOM, 1:N expansion, 0-entry spot preservation, and escaping', () => {
    const spots = makeSampleSpots();
    const csv = generateCsv(spots);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    const body = csv.slice(1);

    // Header + 2 entries from spot-1 + 1 row from 0-entry spot-2 = 4 logical records
    // Because entry-1 memo contains a single \n inside quotes, split only on unquoted \r\n
    expect(body).toContain(
      'spotId,name,status,category,lat,lng,elevation,addressSummary,entryId,entryKind,dateStart,dateEnd,datePrecision,memo,photoCount,photoFiles\r\n'
    );
    expect(body).toContain('"山頂で""ご来光"", 風強い\n寒かった & 最高"');
    expect(body).toContain('35.3606,138.7274,3776');
    expect(body).toContain('spot-2,"A&B ""Cafe""",planned,lifestyle,35.6812,139.7671,,Chiyoda\'s <Station>,,,,,,,0,');

    const pathMap = buildPhotoFilePathMap(spots);
    const p1 = pathMap.get('spot-1\0entry-1\0sharedid1-aaa')!;
    const p2 = pathMap.get('spot-1\0entry-1\0sharedid1-bbb')!;
    expect(body).toContain(`${p1}; ${p2}`);
  });

  it('generates KML with status Folders, lng,lat[,elevation] coordinates, and XML escaping', () => {
    const spots = makeSampleSpots();
    const kml = generateKml(spots);

    expect(kml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(kml).toContain('<Folder>\n      <name>訪問済み</name>');
    expect(kml).toContain('<Folder>\n      <name>訪問予定</name>');
    expect(kml).toContain('<coordinates>138.7274,35.3606,3776</coordinates>');
    expect(kml).toContain('<coordinates>139.7671,35.6812</coordinates>');
    expect(kml).toContain('<name>Mt. Fuji / 富士山 &lt;Main&gt;</name>');
    expect(kml).toContain('<name>A&amp;B &quot;Cafe&quot;</name>');
    expect(kml).toContain('Chiyoda&apos;s &lt;Station&gt;');
    expect(kml).toContain('山頂で&quot;ご来光&quot;, 風強い\n寒かった &amp; 最高');
  });

  it('sanitizes filenames, avoids collisions, packs photos in STORE mode, and skips missing photos in ZIP', async () => {
    expect(sanitizeFileNameSegment('a/b\\c:d*e?f"g<h>i|j\u0000k')).toBe('a_b_c_d_e_f_g_h_i_j_k');

    const spots = makeSampleSpots();
    // Same spot + same date + same 8-char prefix ("sharedid"), different extensions -> still verify collision when same ext
    spots[0].entries[0].photos.push(makePhoto('sharedid1-ccc'));

    const photoMap = new Map<string, StoredPhotoRecord | null>([
      ['sharedid1-aaa', makeStoredPhoto('sharedid1-aaa', 'webp-bytes-1', 'image/webp')],
      ['sharedid1-bbb', makeStoredPhoto('sharedid1-bbb', 'jpeg-bytes-2', 'image/jpeg')],
      ['sharedid1-ccc', null], // missing photo in IndexedDB
    ]);

    const progressEvents: Array<{ phase: string; processed: number; total: number }> = [];
    const exportedAt = new Date(2026, 10, 24, 10, 30, 0);

    const res = await buildExportZipArchive(spots, {
      exportedAt,
      getPhoto: async (id) => photoMap.get(id) ?? null,
      onProgress: (p) => progressEvents.push(p),
    });

    expect(res.fileName).toBe('3d-visit-record_2026-11-24.zip');
    expect(progressEvents[0]).toEqual({ phase: 'preparing', processed: 0, total: 3 });
    expect(progressEvents.filter((e) => e.phase === 'reading-photos')).toEqual([
      { phase: 'reading-photos', processed: 1, total: 3 },
      { phase: 'reading-photos', processed: 2, total: 3 },
      { phase: 'reading-photos', processed: 3, total: 3 },
    ]);
    expect(progressEvents[progressEvents.length - 1]).toEqual({
      phase: 'packaging',
      processed: 3,
      total: 3,
    });

    const zipBytes = new Uint8Array(await res.blob.arrayBuffer());
    const entries = unzipSync(zipBytes);

    expect(Object.keys(entries)).toContain('manifest.json');
    expect(Object.keys(entries)).toContain('visits.geojson');
    expect(Object.keys(entries)).toContain('visits.csv');
    expect(Object.keys(entries)).toContain('visits.kml');

    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as ExportManifest;
    expect(manifest.spotCount).toBe(2);
    expect(manifest.entryCount).toBe(2);
    expect(manifest.totalPhotoRefs).toBe(3);
    expect(manifest.includedPhotoCount).toBe(2);
    expect(manifest.missingPhotoCount).toBe(1);
    expect(manifest.missingPhotos[0].photoId).toBe('sharedid1-ccc');

    const pathMap = buildPhotoFilePathMap(spots);
    const path1 = pathMap.get('spot-1\0entry-1\0sharedid1-aaa')!;
    const path2 = pathMap.get('spot-1\0entry-1\0sharedid1-bbb')!;
    const path3 = pathMap.get('spot-1\0entry-1\0sharedid1-ccc')!;

    expect(path1).not.toBe(path3);
    expect(path1).toMatch(/^photos\/2026-07-15_Mt\.?_?Fuji_富士山_Main_sharedid\.webp$/);
    expect(path2).toMatch(/\.jpg$/);
    expect(path3).toMatch(/-2\.webp$/);

    expect(strFromU8(entries[path1])).toBe('webp-bytes-1');
    expect(strFromU8(entries[path2])).toBe('jpeg-bytes-2');
    expect(entries[path3]).toBeUndefined();

    // Verify STORE (method 0) for compressed image files
    expect(findZipCompressionMethod(zipBytes, path1)).toBe(0);
    expect(findZipCompressionMethod(zipBytes, path2)).toBe(0);
  });

  it('aborts ZIP export cleanly when AbortSignal is triggered', async () => {
    const spots = makeSampleSpots();
    const controller = new AbortController();

    await expect(
      buildExportZipArchive(spots, {
        signal: controller.signal,
        getPhoto: async () => {
          controller.abort();
          return makeStoredPhoto('x', 'data');
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('filters spots by status and category and builds dated filenames', () => {
    const spots = makeSampleSpots();
    expect(filterSpotsForExport(spots, { status: 'all', category: 'all' })).toHaveLength(2);
    expect(filterSpotsForExport(spots, { status: 'visited', category: 'all' }).map((s) => s.id)).toEqual(['spot-1']);
    expect(filterSpotsForExport(spots, { status: 'planned', category: 'all' }).map((s) => s.id)).toEqual([
      'spot-1',
      'spot-2',
    ]);
    expect(filterSpotsForExport(spots, { status: 'planned', category: 'lifestyle' }).map((s) => s.id)).toEqual([
      'spot-2',
    ]);

    const date = new Date(2026, 10, 24, 9, 0, 0);
    expect(buildExportFileName('geojson', date)).toBe('3d-visit-record_2026-11-24.geojson');
    expect(buildExportFileName('csv', date)).toBe('3d-visit-record_2026-11-24.csv');
    expect(buildExportFileName('kml', date)).toBe('3d-visit-record_2026-11-24.kml');
    expect(buildExportFileName('zip', date)).toBe('3d-visit-record_2026-11-24.zip');
  });
});
