import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayerMenu } from '../src/components/LayerMenu';
import { PrefectureSummaryLegend } from '../src/components/PrefectureSummaryLegend';
import type { PrefectureStats, WebGPUStatus } from '../src/types/visit';

const SAMPLE_GPU: WebGPUStatus = {
  backend: 'webgpu',
  webgpuAvailable: true,
  adapterInfo: 'Mock WebGPU',
  fps: 60,
};

const SAMPLE_STATS: PrefectureStats = {
  totalPrefectures: 47,
  visitedCount: 12,
  plannedOnlyCount: 3,
  unvisitedCount: 32,
  byCode: {},
  items: [],
};

describe('LayerMenu prefecture fill overlay toggle', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders switch OFF by default and calls onTogglePrefectureFill when toggled', () => {
    const onTogglePrefectureFill = vi.fn();

    render(
      <LayerMenu
        exaggeration={1.5}
        onChangeExaggeration={vi.fn()}
        baseMap="osm"
        onChangeBaseMap={vi.fn()}
        prefectureFillEnabled={false}
        onTogglePrefectureFill={onTogglePrefectureFill}
        prefectureStats={null}
        gpuStatus={SAMPLE_GPU}
        isOpen={true}
        onToggleOpen={vi.fn()}
        onShareView={vi.fn()}
        onNavigatePolicy={vi.fn()}
      />
    );

    const toggle = screen.getByRole('switch', { name: /都道府県塗りつぶし/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByTestId('layer-menu-prefecture-summary')).toBeNull();

    fireEvent.click(toggle);
    expect(onTogglePrefectureFill).toHaveBeenCalledTimes(1);
    expect(onTogglePrefectureFill).toHaveBeenCalledWith(true);
  });

  it('shows vertical summary counts with right-aligned tabular numerals when enabled with stats', () => {
    render(
      <LayerMenu
        exaggeration={1.5}
        onChangeExaggeration={vi.fn()}
        baseMap="photo"
        onChangeBaseMap={vi.fn()}
        prefectureFillEnabled={true}
        onTogglePrefectureFill={vi.fn()}
        prefectureStats={SAMPLE_STATS}
        gpuStatus={SAMPLE_GPU}
        isOpen={true}
        onToggleOpen={vi.fn()}
        onShareView={vi.fn()}
        onNavigatePolicy={vi.fn()}
      />
    );

    const toggle = screen.getByRole('switch', { name: /都道府県塗りつぶし/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    const summary = screen.getByTestId('layer-menu-prefecture-summary');
    expect(summary.textContent).toContain('都道府県(47)');

    const terms = Array.from(summary.querySelectorAll('dt')).map((el) =>
      el.textContent?.trim()
    );
    const definitions = Array.from(summary.querySelectorAll('dd'));
    expect(terms).toEqual(['訪問済み', '予定あり', '未訪問']);
    expect(definitions.map((el) => el.textContent?.trim())).toEqual(['12', '3', '32']);
    for (const dd of definitions) {
      expect(dd.className).toContain('text-right');
      expect(dd.className).toContain('tabular-nums');
    }
  });

  it('renders compact PrefectureSummaryLegend without progress bar and preserves 1-digit/2-digit alignment', () => {
    const compactStats: PrefectureStats = {
      totalPrefectures: 47,
      visitedCount: 14,
      plannedOnlyCount: 8,
      unvisitedCount: 0,
      byCode: {},
      items: [],
    };

    const { container } = render(<PrefectureSummaryLegend stats={compactStats} compact />);

    expect(screen.getByText('都道府県(47)')).toBeTruthy();
    expect(container.querySelector('.h-1\\.5')).toBeNull();

    const terms = Array.from(container.querySelectorAll('dt')).map((el) =>
      el.textContent?.trim()
    );
    const definitions = Array.from(container.querySelectorAll('dd'));
    expect(terms).toEqual(['訪問済み', '予定あり', '未訪問']);
    expect(definitions.map((el) => el.textContent?.trim())).toEqual(['14', '8', '0']);
    for (const dd of definitions) {
      expect(dd.className).toContain('text-right');
      expect(dd.className).toContain('tabular-nums');
    }
  });

  it('shows loading and retry UI cleanly when loading or errored', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <LayerMenu
        exaggeration={1.5}
        onChangeExaggeration={vi.fn()}
        baseMap="hillshade"
        onChangeBaseMap={vi.fn()}
        prefectureFillEnabled={true}
        onTogglePrefectureFill={vi.fn()}
        prefectureStats={null}
        isPrefectureLoading={true}
        prefectureLoadError={null}
        onRetryPrefectureLoad={onRetry}
        gpuStatus={SAMPLE_GPU}
        isOpen={true}
        onToggleOpen={vi.fn()}
        onShareView={vi.fn()}
        onNavigatePolicy={vi.fn()}
      />
    );

    expect(screen.getByText('都道府県データを読み込み中...')).toBeTruthy();

    rerender(
      <LayerMenu
        exaggeration={1.5}
        onChangeExaggeration={vi.fn()}
        baseMap="hillshade"
        onChangeBaseMap={vi.fn()}
        prefectureFillEnabled={true}
        onTogglePrefectureFill={vi.fn()}
        prefectureStats={null}
        isPrefectureLoading={false}
        prefectureLoadError="読み込みエラー"
        onRetryPrefectureLoad={onRetry}
        gpuStatus={SAMPLE_GPU}
        isOpen={true}
        onToggleOpen={vi.fn()}
        onShareView={vi.fn()}
        onNavigatePolicy={vi.fn()}
      />
    );

    expect(screen.getByText('読み込みエラー')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
