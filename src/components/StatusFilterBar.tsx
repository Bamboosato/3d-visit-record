import React from 'react';
import { CheckCircle2, Clock, Layers } from 'lucide-react';
import type { StatusFilterValue } from '../types/visit';

interface StatusFilterBarProps {
  value: StatusFilterValue;
  onChange: (next: StatusFilterValue) => void;
  counts: {
    all: number;
    visited: number;
    planned: number;
  };
  connectedLeft?: boolean;
}

export const StatusFilterBar: React.FC<StatusFilterBarProps> = ({
  value,
  onChange,
  counts,
  connectedLeft = false,
}) => {
  const options: Array<{
    id: StatusFilterValue;
    label: string;
    count: number;
    icon: React.ReactNode;
    activeClass: string;
  }> = [
    {
      id: 'all',
      label: 'すべて',
      count: counts.all,
      icon: <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />,
      activeClass: 'bg-sky-500/25 text-sky-100 border-sky-400/60 shadow-sky-500/20',
    },
    {
      id: 'visited',
      label: '訪問済み',
      count: counts.visited,
      icon: <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden="true" />,
      activeClass: 'bg-emerald-500/25 text-emerald-100 border-emerald-400/60 shadow-emerald-500/20',
    },
    {
      id: 'planned',
      label: '訪問予定',
      count: counts.planned,
      icon: <Clock className="w-3.5 h-3.5 shrink-0 text-amber-400" aria-hidden="true" />,
      activeClass: 'bg-amber-500/25 text-amber-100 border-amber-400/60 shadow-amber-500/20',
    },
  ];

  return (
    <nav
      aria-label="地図上のステータス絞り込み"
      className={`pointer-events-auto inline-flex items-center gap-0.5 sm:gap-1 p-1 rounded-full bg-slate-900/90 backdrop-blur-md border border-slate-700/80 shadow-lg ${
        connectedLeft ? 'md:rounded-l-none md:border-l-0 md:pl-1.5 md:min-h-[42px]' : ''
      }`}
    >
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            id={`status-filter-${opt.id}`}
            aria-pressed={active}
            onClick={() => onChange(opt.id)}
            className={`whitespace-nowrap inline-flex items-center gap-1.5 min-h-[34px] px-2.5 sm:px-3 py-1 rounded-full text-xs font-semibold border transition-colors cursor-pointer ${
              active
                ? `${opt.activeClass} shadow`
                : 'border-transparent text-slate-300 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            {opt.icon}
            <span>{opt.label}</span>
            <span className="tabular-nums text-[11px] opacity-85">{opt.count}</span>
          </button>
        );
      })}
    </nav>
  );
};
