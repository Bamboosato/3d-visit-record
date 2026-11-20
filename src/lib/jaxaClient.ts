import { bounded } from './asyncLifecycle';
import type { DataObject, JaxaEarthModule, TileGenerator } from '../types/jaxa';
import * as localJaxaEarth from './jaxa.earth.esm.js';

export const JAXA_EARTH_ESM_URL =
  'https://data.earth.jaxa.jp/api/javascript/v2.0.1/jaxa.earth.esm.js';

export const AW3D30_COLLECTION_URL =
  'https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/JAXA.EORC_ALOS.PRISM_AW3D30.v3.2_global/collection.json';

export const AW3D30_MAX_LAT = 82;

let jaxaModulePromise: Promise<JaxaEarthModule> | null = null;
const aw3dTileGenerators = new Map<number, Promise<TileGenerator>>();

export async function getJaxaEarth(): Promise<JaxaEarthModule> {
  if (!jaxaModulePromise) {
    jaxaModulePromise = (async () => {
      try {
        const remoteMod = (await bounded(
          import(/* @vite-ignore */ JAXA_EARTH_ESM_URL),
          1500
        )) as unknown as JaxaEarthModule;
        return remoteMod;
      } catch {
        return localJaxaEarth as unknown as JaxaEarthModule;
      }
    })();
  }
  return jaxaModulePromise;
}

export async function getAW3DTileGenerator(tileSize = 256): Promise<TileGenerator> {
  if (!aw3dTileGenerators.has(tileSize)) {
    const pending = (async () => {
      const je = await getJaxaEarth();
      const tg = new je.TileGenerator({
        collectionUrl: AW3D30_COLLECTION_URL,
        band: 'DSM',
        tileSize,
        delay: 0,
      });
      await bounded(tg.init(), 10000);
      return tg;
    })();
    aw3dTileGenerators.set(tileSize, pending);
    void pending.catch(() => {
      if (aw3dTileGenerators.get(tileSize) === pending) {
        aw3dTileGenerators.delete(tileSize);
      }
    });
  }
  return aw3dTileGenerators.get(tileSize)!;
}

/**
 * 任意の経緯度における AW3D30 標高 (m) を取得します。
 * 全球対応のため経度 [-180, 180]・緯度 [-82, 82] で BBox をクランプし、
 * 緯度 ±82° 超の極地は取得対象外として即座に null を返します。
 */
export async function fetchPointElevationFromAW3D(
  lng: number,
  lat: number,
  signal?: AbortSignal
): Promise<number | null> {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lng) > 180 || Math.abs(lat) > AW3D30_MAX_LAT) {
    return null;
  }

  try {
    const je = await getJaxaEarth();
    if (signal?.aborted) return null;

    const dl = 0.02;
    const minLng = Math.max(-180, lng - dl);
    const maxLng = Math.min(180, lng + dl);
    const minLat = Math.max(-AW3D30_MAX_LAT, lat - dl);
    const maxLat = Math.min(AW3D30_MAX_LAT, lat + dl);

    if (maxLng <= minLng || maxLat <= minLat) return null;

    const dataObj: DataObject = await bounded(
      je.getDataObject({
        collectionUrl: AW3D30_COLLECTION_URL,
        band: 'DSM',
        bbox: [minLng, minLat, maxLng, maxLat],
        width: 16,
        height: 16,
        resampling: je.Resampling.BILINEAR,
      }),
      15000,
      signal
    );

    const isp = new je.data.Inspector(dataObj);
    const val = isp.getValueByCoordinateXY(lng, lat);
    if (val !== null && Number.isFinite(val)) {
      return Math.round(val);
    }
  } catch {
    // 取得失敗・中断時は null
  }
  return null;
}
