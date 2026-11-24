import React from 'react';
import type { PrefectureStats } from '../types/visit';

interface PrefectureSummaryLegendProps {
  stats: PrefectureStats;
  showProgressBar?: boolean;
  compact?: boolean;
}

export const PrefectureSummaryLegend: React.FC<PrefectureSummaryLegendProps> = ({
  stats,
  showProgressBar = false,
  compact = false,
}) => {
  const rows = [
    {
      key: 'visited',
      label: '訪問済み',
      count: stats.visitedCount,
      dotClass: 'bg-emerald-500 ring-1 ring-emerald-300/80',
      countClass: 'text-emerald-300',
    },
    {
      key: 'planned',
      label: '予定あり',
      count: stats.plannedOnlyCount,
      dotClass: 'bg-amber-500 ring-1 ring-amber-300/80',
      countClass: 'text-amber-300',
    },
    {
      key: 'none',
      label: '未訪問',
      count: stats.unvisitedCount,
      dotClass: 'bg-slate-500/80 ring-1 ring-slate-300/70',
      countClass: 'text-slate-300',
    },
  ] as const;

  return (
    <div className={compact ? 'space-y-1' : 'space-y-2'}>
      <div className="text-[11px] font-bold text-slate-200 tabular-nums">
        都道府県({stats.totalPrefectures})
      </div>

      {showProgressBar && (
        <div
          className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden flex"
          aria-hidden="true"
        >
          {stats.totalPrefectures > 0 && (
            <>
              <div
                className="h-full bg-emerald-500 transition-[width] duration-300"
                style={{
                  width: `${(stats.visitedCount / stats.totalPrefectures) * 100}%`,
                }}
              />
              <div
                className="h-full bg-amber-500 transition-[width] duration-300"
                style={{
                  width: `${(stats.plannedOnlyCount / stats.totalPrefectures) * 100}%`,
                }}
              />
            </>
          )}
        </div>
      )}

      <dl
        className={`grid grid-cols-[1fr_auto] items-center ${
          compact ? 'gap-x-3 gap-y-0.5 text-[11px]' : 'gap-x-4 gap-y-1 text-[11px]'
        }`}
      >
        {rows.map((row) => (
          <React.Fragment key={row.key}>
            <dt className="inline-flex items-center gap-1.5 text-slate-200 whitespace-nowrap">
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${row.dotClass}`}
                aria-hidden="true"
              />
              <span>{row.label}</span>
            </dt>
            <dd className={`text-right font-bold tabular-nums min-w-[2ch] ${row.countClass}`}>
              {row.count}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
};
