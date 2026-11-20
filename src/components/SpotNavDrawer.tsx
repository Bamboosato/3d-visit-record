import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  Clock,
  Compass,
  Loader2,
  MapPin,
  Mountain,
  Pin,
  Search,
  X,
} from 'lucide-react';
import type {
  InspectedPoint,
  PresetMountain,
  SpotCategory,
  StatusFilterValue,
  VisitSpot,
} from '../types/visit';
import { AREA_GROUPS, HYAKUMEIZAN_PRESETS } from '../lib/hyakumeizanData';
import { SPOT_CATEGORY_LIST, getSpotCategoryMeta } from '../lib/spotCategories';
import {
  isHybridSpot,
  matchHyakumeizanSpot,
  matchesStatusFilter,
  getSpotSortDateKey,
} from '../lib/spotDomain';
import {
  doesVisitDateOverlapYear,
  extractDistinctYears,
  formatVisitDate,
} from '../lib/visitDate';
import {
  calcDistanceMeters,
  formatDistanceLabel,
  searchOsmLocationsByKeyword,
  type OsmSearchLocation,
  type SearchReferenceLocation,
} from '../lib/osmPlaceClient';

export type NavTabId = 'spots' | 'search' | 'hyakumeizan';
type SortMode = 'date' | 'distance' | 'recent';

interface SpotNavDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  spots: VisitSpot[];
  referenceLocation?: SearchReferenceLocation;
  onSelectSpot: (spot: VisitSpot) => void;
  onSelectSearchLocation: (point: InspectedPoint, zoom: number) => void;
  onSelectMountain: (mountain: PresetMountain, matchedSpot: VisitSpot | null) => void;
}

export const SpotNavDrawer: React.FC<SpotNavDrawerProps> = ({
  isOpen,
  onClose,
  spots,
  referenceLocation,
  onSelectSpot,
  onSelectSearchLocation,
  onSelectMountain,
}) => {
  const [activeTab, setActiveTab] = useState<NavTabId>('spots');

  // 登録地点一覧フィルタ
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('all');
  const [categoryFilter, setCategoryFilter] = useState<SpotCategory | 'all'>('all');
  const [yearFilter, setYearFilter] = useState<string>('all'); // 'all' | 'none' | 'YYYY'
  const [keyword, setKeyword] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('date');

  // 地名・施設検索
  const [searchQuery, setSearchQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<OsmSearchLocation[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  // 百名山絞り込み
  const [selectedArea, setSelectedArea] = useState<string>('ALL');
  const [selectedPref, setSelectedPref] = useState<string>('ALL');

  useEffect(() => {
    return () => searchAbortRef.current?.abort();
  }, []);

  const summaryCounts = useMemo(() => {
    let visited = 0;
    let planned = 0;
    for (const s of spots) {
      if (s.status === 'visited') visited++;
      else planned++;
    }
    return { visited, planned, total: spots.length };
  }, [spots]);

  const availableYears = useMemo(() => extractDistinctYears(spots), [spots]);

  const filteredSpots = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const list = spots.filter((spot) => {
      if (!matchesStatusFilter(spot, statusFilter)) return false;
      if (categoryFilter !== 'all' && spot.category !== categoryFilter) return false;
      if (yearFilter === 'none') {
        if (!spot.entries.some((e) => e.date.precision === 'none')) return false;
      } else if (yearFilter !== 'all') {
        const y = Number(yearFilter);
        if (!spot.entries.some((e) => doesVisitDateOverlapYear(e.date, y))) return false;
      }
      if (q) {
        const nameHit = spot.name.toLowerCase().includes(q);
        const addrHit = spot.addressSummary?.toLowerCase().includes(q) ?? false;
        const memoHit = spot.entries.some((e) => e.memo.toLowerCase().includes(q));
        if (!nameHit && !addrHit && !memoHit) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (sortMode === 'distance' && referenceLocation) {
        const da = calcDistanceMeters(
          referenceLocation.lat,
          referenceLocation.lng,
          a.center[1],
          a.center[0]
        );
        const db = calcDistanceMeters(
          referenceLocation.lat,
          referenceLocation.lng,
          b.center[1],
          b.center[0]
        );
        return da - db;
      }
      if (sortMode === 'date') {
        const ka = getSpotSortDateKey(a, statusFilter);
        const kb = getSpotSortDateKey(b, statusFilter);
        if (ka && !kb) return -1;
        if (!ka && kb) return 1;
        if (ka !== kb) return kb.localeCompare(ka);
      }
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  }, [spots, statusFilter, categoryFilter, yearFilter, keyword, sortMode, referenceLocation]);

  // キーワードに一致する登録済み地点（検索タブでも横断表示）
  const matchingLocalSpotsForSearch = useMemo(() => {
    const q = submittedQuery.trim().toLowerCase();
    if (!q) return [];
    return spots
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.addressSummary?.toLowerCase().includes(q) ?? false) ||
          s.entries.some((e) => e.memo.toLowerCase().includes(q))
      )
      .slice(0, 5);
  }, [spots, submittedQuery]);

  // 百名山マッチングと達成数
  const mountainMatches = useMemo(() => {
    const map = new Map<string, VisitSpot | null>();
    let visitedCount = 0;
    let plannedCount = 0;
    for (const m of HYAKUMEIZAN_PRESETS) {
      const matched = matchHyakumeizanSpot(m, spots);
      map.set(m.id, matched);
      if (matched?.status === 'visited') visitedCount++;
      else if (matched?.status === 'planned') plannedCount++;
    }
    return { map, visitedCount, plannedCount };
  }, [spots]);

  const areaPrefectures = useMemo(() => {
    const prefs = new Set<string>();
    for (const m of HYAKUMEIZAN_PRESETS) {
      if (selectedArea === 'ALL' || m.areaGroup === selectedArea) {
        m.prefectures.forEach((p) => prefs.add(p));
      }
    }
    return [...prefs];
  }, [selectedArea]);

  const filteredMountains = useMemo(() => {
    return HYAKUMEIZAN_PRESETS.filter((m) => {
      if (selectedArea !== 'ALL' && m.areaGroup !== selectedArea) return false;
      if (selectedPref !== 'ALL' && !m.prefectures.includes(selectedPref)) return false;
      return true;
    });
  }, [selectedArea, selectedPref]);

  const handleRunSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setSubmittedQuery(trimmed);
    setIsSearching(true);
    setSearchError(null);

    try {
      const items = await searchOsmLocationsByKeyword(
        trimmed,
        controller.signal,
        (partial) => {
          if (!controller.signal.aborted) setSearchResults(partial);
        },
        referenceLocation
      );
      if (!controller.signal.aborted) {
        setSearchResults(items);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (!controller.signal.aborted) {
        setSearchError('検索に失敗しました。時間をおいて再試行してください。');
      }
    } finally {
      if (!controller.signal.aborted) setIsSearching(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center pt-16 sm:pt-20 px-3 pb-4 pointer-events-auto">
      <div
        className="fixed inset-0 bg-slate-950/60 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        aria-label="地点一覧・検索ナビゲーション"
        className="relative z-10 w-full max-w-2xl rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/90 shadow-2xl flex flex-col max-h-[80dvh] overflow-hidden"
      >
        {/* Tab header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-slate-800 bg-slate-950/50">
          <div role="tablist" aria-label="ナビゲーション切替" className="flex items-center gap-1">
            <button
              type="button"
              role="tab"
              id="nav-tab-spots"
              aria-selected={activeTab === 'spots'}
              onClick={() => setActiveTab('spots')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                activeTab === 'spots'
                  ? 'bg-sky-600 text-white shadow'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
              <span>登録地点 ({summaryCounts.total})</span>
            </button>
            <button
              type="button"
              role="tab"
              id="nav-tab-search"
              aria-selected={activeTab === 'search'}
              onClick={() => setActiveTab('search')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                activeTab === 'search'
                  ? 'bg-sky-600 text-white shadow'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Search className="w-3.5 h-3.5" aria-hidden="true" />
              <span>地名・施設検索</span>
            </button>
            <button
              type="button"
              role="tab"
              id="nav-tab-hyakumeizan"
              aria-selected={activeTab === 'hyakumeizan'}
              onClick={() => setActiveTab('hyakumeizan')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                activeTab === 'hyakumeizan'
                  ? 'bg-sky-600 text-white shadow'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Mountain className="w-3.5 h-3.5" aria-hidden="true" />
              <span>百名山</span>
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ナビゲーションを閉じる"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab body */}
        <div className="p-3.5 overflow-y-auto space-y-3 min-h-[22rem]">
          {activeTab === 'spots' && (
            <div className="space-y-3">
              {/* Summary + Sort */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold">
                    訪問済み {summaryCounts.visited}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold">
                    予定 {summaryCounts.planned}
                  </span>
                </div>
                <select
                  aria-label="並び順"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
                >
                  <option value="date">訪問・予定日順</option>
                  <option value="distance">現在位置に近い順</option>
                  <option value="recent">更新日時順</option>
                </select>
              </div>

              {/* Filter controls */}
              <div className="space-y-2 p-2.5 rounded-xl bg-slate-950/60 border border-slate-800">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(['all', 'visited', 'planned'] as StatusFilterValue[]).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setStatusFilter(st)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer ${
                        statusFilter === st
                          ? 'bg-sky-500/25 border-sky-400/60 text-white'
                          : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      {st === 'all' ? 'すべて' : st === 'visited' ? '訪問済み' : '訪問予定'}
                    </button>
                  ))}

                  <select
                    aria-label="年・時期で絞り込み"
                    value={yearFilter}
                    onChange={(e) => setYearFilter(e.target.value)}
                    className="ml-auto px-2 py-1 rounded-lg bg-slate-900 border border-slate-700 text-[11px] text-slate-200"
                  >
                    <option value="all">すべての年・時期</option>
                    <option value="none">時期未定を含む</option>
                    {availableYears.map((y) => (
                      <option key={y} value={String(y)}>
                        {y}年
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-4 gap-1.5">
                  {SPOT_CATEGORY_LIST.map((cat) => {
                    const Icon = cat.icon;
                    const active = categoryFilter === cat.id;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => setCategoryFilter(active ? 'all' : cat.id)}
                        className={`flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg border text-[11px] font-semibold cursor-pointer ${
                          active
                            ? cat.activeBgClass
                            : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-600'
                        }`}
                      >
                        <Icon className="w-3 h-3" aria-hidden="true" />
                        <span>{cat.label}</span>
                      </button>
                    );
                  })}
                </div>

                <input
                  type="search"
                  aria-label="地点名・住所・メモで絞り込み"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="地点名・地名・メモを絞り込み..."
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-base sm:text-xs text-white placeholder:text-slate-500"
                />
              </div>

              {/* Spot cards */}
              {filteredSpots.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400 space-y-1">
                  <p>条件に一致する登録地点がありません。</p>
                  <p>地図上の任意の場所をタップするか、「地名・施設検索」から登録できます。</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {filteredSpots.map((spot) => {
                    const catMeta = getSpotCategoryMeta(spot.category);
                    const CatIcon = catMeta.icon;
                    const latestEntry = spot.entries[0];
                    const dist = referenceLocation
                      ? calcDistanceMeters(
                          referenceLocation.lat,
                          referenceLocation.lng,
                          spot.center[1],
                          spot.center[0]
                        )
                      : undefined;
                    return (
                      <li key={spot.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectSpot(spot);
                            onClose();
                          }}
                          className="w-full text-left p-3 rounded-xl bg-slate-950/70 hover:bg-slate-800/80 border border-slate-800 hover:border-sky-400/60 transition-colors flex items-start gap-2.5 cursor-pointer"
                        >
                          <span
                            className={`mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${catMeta.badgeBgClass}`}
                          >
                            <CatIcon className="w-4 h-4" aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {spot.isPinned && (
                                  <Pin className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                                )}
                                <span className="font-bold text-sm text-white truncate">
                                  {spot.name}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {isHybridSpot(spot) && (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 text-[10px] font-semibold">
                                    再訪予定
                                  </span>
                                )}
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                    spot.status === 'visited'
                                      ? 'bg-emerald-500/20 text-emerald-300'
                                      : 'bg-amber-500/20 text-amber-300'
                                  }`}
                                >
                                  {spot.status === 'visited' ? '訪問済み' : '予定'}
                                </span>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2.5 text-[11px] text-slate-400">
                              {spot.addressSummary && <span>{spot.addressSummary}</span>}
                              {latestEntry && (
                                <span className="inline-flex items-center gap-1 text-slate-300">
                                  <Calendar className="w-3 h-3 text-sky-400" aria-hidden="true" />
                                  {formatVisitDate(latestEntry.date)}
                                </span>
                              )}
                              {dist !== undefined && <span>{formatDistanceLabel(dist)}</span>}
                            </div>
                            {latestEntry?.memo && (
                              <p className="text-[11px] text-slate-400 truncate">
                                {latestEntry.memo}
                              </p>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {activeTab === 'search' && (
            <div className="space-y-3">
              <form onSubmit={handleRunSearch} className="flex items-center gap-2">
                <input
                  id="global-place-search-input"
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="日本・海外の地名、山名、観光地、駅名を入力..."
                  className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-base sm:text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-400"
                />
                <button
                  type="submit"
                  id="global-place-search-submit"
                  disabled={isSearching || !searchQuery.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  {isSearching ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Search className="w-4 h-4" aria-hidden="true" />
                  )}
                  <span>検索</span>
                </button>
              </form>

              <p className="text-[11px] text-slate-400">
                OpenStreetMap（全世界）＋ 国土地理院（日本国内補完）を横断検索します。
              </p>

              {searchError && (
                <p className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-xs text-rose-200">
                  {searchError}
                </p>
              )}

              {matchingLocalSpotsForSearch.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-[11px] font-bold text-emerald-300">登録済みの地点から一致</h3>
                  <ul className="space-y-1.5">
                    {matchingLocalSpotsForSearch.map((spot) => (
                      <li key={spot.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectSpot(spot);
                            onClose();
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-500/40 flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <div className="font-bold text-xs text-white truncate">{spot.name}</div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {spot.addressSummary || `${spot.center[1].toFixed(3)}, ${spot.center[0].toFixed(3)}`}
                            </div>
                          </div>
                          <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold shrink-0">
                            {spot.status === 'visited' ? '訪問済み' : '予定'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {searchResults.length > 0 ? (
                <ul className="space-y-1.5">
                  {searchResults.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectSearchLocation(
                            {
                              lng: item.lng,
                              lat: item.lat,
                              elevation: null,
                              label: item.name,
                              addressSummary: item.subLabel,
                              recommendedZoom: item.recommendedZoom,
                            },
                            item.recommendedZoom
                          );
                          onClose();
                        }}
                        className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-950/75 hover:bg-slate-800/80 border border-slate-800 hover:border-sky-400/60 flex items-center justify-between gap-2 cursor-pointer"
                      >
                        <div className="min-w-0 flex items-center gap-2.5">
                          <span className="text-lg shrink-0" aria-hidden="true">
                            {item.emoji}
                          </span>
                          <div className="min-w-0">
                            <div className="font-bold text-xs text-white truncate">{item.name}</div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {item.subLabel}
                              {item.distanceMeters !== undefined
                                ? ` · ${formatDistanceLabel(item.distanceMeters)}`
                                : ''}
                            </div>
                          </div>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] shrink-0">
                          {item.category}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                submittedQuery &&
                !isSearching && (
                  <p className="py-6 text-center text-xs text-slate-400">
                    「{submittedQuery}」に一致する場所が見つかりませんでした。
                  </p>
                )
              )}
            </div>
          )}

          {activeTab === 'hyakumeizan' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 font-bold">
                    <Compass className="w-3.5 h-3.5" aria-hidden="true" />
                    踏破 {mountainMatches.visitedCount} / 100 座
                  </span>
                  {mountainMatches.plannedCount > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-200 font-semibold">
                      予定 {mountainMatches.plannedCount} 座
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select
                  aria-label="山域を選択"
                  value={selectedArea}
                  onChange={(e) => {
                    setSelectedArea(e.target.value);
                    setSelectedPref('ALL');
                  }}
                  className="px-2.5 py-1.5 rounded-xl bg-slate-950 border border-slate-700 text-xs text-slate-200"
                >
                  <option value="ALL">すべての山域（100座）</option>
                  {AREA_GROUPS.map((area) => (
                    <option key={area} value={area}>
                      {area}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="都道府県を選択"
                  value={selectedPref}
                  onChange={(e) => setSelectedPref(e.target.value)}
                  className="px-2.5 py-1.5 rounded-xl bg-slate-950 border border-slate-700 text-xs text-slate-200"
                >
                  <option value="ALL">すべての都道府県</option>
                  {areaPrefectures.map((pref) => (
                    <option key={pref} value={pref}>
                      {pref}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {filteredMountains.map((m) => {
                  const matched = mountainMatches.map.get(m.id) ?? null;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        onSelectMountain(m, matched);
                        onClose();
                      }}
                      className="text-left p-2.5 rounded-xl bg-slate-950/75 hover:bg-slate-800/80 border border-slate-800 hover:border-sky-400/60 flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-xs text-white truncate">
                          {m.emoji} {m.name}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate">
                          {m.region} · {m.elevation.toLocaleString()}m
                        </div>
                      </div>
                      {matched && (
                        <span
                          className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${
                            matched.status === 'visited'
                              ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/50'
                              : 'bg-amber-500/25 text-amber-200 border border-amber-400/50'
                          }`}
                        >
                          {matched.status === 'visited' ? (
                            <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                          ) : (
                            <Clock className="w-3 h-3" aria-hidden="true" />
                          )}
                          <span>{matched.status === 'visited' ? '済' : '予定'}</span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
