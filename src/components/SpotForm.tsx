import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Loader2, Sparkles, X } from 'lucide-react';
import {
  MAX_MEMO_LENGTH,
  MAX_SPOT_NAME_LENGTH,
  type SpotCategory,
  type SpotStatus,
  type VisitDate,
  type VisitDatePrecision,
} from '../types/visit';
import { SPOT_CATEGORY_LIST } from '../lib/spotCategories';
import {
  getCurrentMonthString,
  getTodayDateString,
  normalizeVisitDate,
} from '../lib/visitDate';
import { hasControlCharacters, sanitizeMemo, sanitizeSpotName } from '../lib/spotDomain';
import { formatDistanceLabel, type OsmPlaceCandidate } from '../lib/osmPlaceClient';

export type SpotFormMode =
  | 'create-spot'
  | 'edit-spot'
  | 'add-entry'
  | 'edit-entry'
  | 'convert-to-visited';

export interface SpotFormSubmitPayload {
  name?: string;
  category?: SpotCategory;
  isPinned?: boolean;
  kind?: SpotStatus;
  date?: VisitDate;
  memo?: string;
}

interface SpotFormProps {
  mode: SpotFormMode;
  initialName?: string;
  initialCategory?: SpotCategory;
  initialIsPinned?: boolean;
  initialKind?: SpotStatus;
  initialDate?: VisitDate;
  initialMemo?: string;
  osmCandidates?: OsmPlaceCandidate[];
  isLoadingOsm?: boolean;
  submitting?: boolean;
  onSubmit: (payload: SpotFormSubmitPayload) => void | Promise<void>;
  onCancel: () => void;
}

const PRECISION_LABELS: Array<{ id: VisitDatePrecision; label: string }> = [
  { id: 'day', label: '年月日' },
  { id: 'month', label: '年月' },
  { id: 'year', label: '年のみ' },
  { id: 'none', label: '時期未定' },
];

export const SpotForm: React.FC<SpotFormProps> = ({
  mode,
  initialName = '',
  initialCategory = 'nature',
  initialIsPinned = false,
  initialKind = 'visited',
  initialDate,
  initialMemo = '',
  osmCandidates = [],
  isLoadingOsm = false,
  submitting = false,
  onSubmit,
  onCancel,
}) => {
  const showSpotMeta = mode === 'create-spot' || mode === 'edit-spot';
  const showEntryFields = mode !== 'edit-spot';

  const defaultDate: VisitDate = useMemo(() => {
    if (initialDate) return initialDate;
    if (mode === 'convert-to-visited') {
      return { precision: 'day', start: getTodayDateString() };
    }
    return initialKind === 'visited'
      ? { precision: 'day', start: getTodayDateString() }
      : { precision: 'none' };
  }, [initialDate, mode, initialKind]);

  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState<SpotCategory>(initialCategory);
  const [isPinned, setIsPinned] = useState(initialIsPinned);
  const [kind, setKind] = useState<SpotStatus>(
    mode === 'convert-to-visited' ? 'visited' : initialKind
  );
  const [precision, setPrecision] = useState<VisitDatePrecision>(defaultDate.precision);
  const [startVal, setStartVal] = useState(defaultDate.start ?? '');
  const [endVal, setEndVal] = useState(defaultDate.end ?? '');
  const [useRange, setUseRange] = useState(Boolean(defaultDate.end));
  const [memo, setMemo] = useState(initialMemo);

  const [touched, setTouched] = useState({
    name: false,
    start: false,
    end: false,
    memo: false,
  });
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const hasUserEditedNameRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const startInputRef = useRef<HTMLInputElement | null>(null);
  const endInputRef = useRef<HTMLInputElement | null>(null);
  const memoInputRef = useRef<HTMLTextAreaElement | null>(null);

  const uid = useId();
  const nameHintId = `${uid}-name-hint`;
  const nameErrorId = `${uid}-name-err`;
  const startHintId = `${uid}-start-hint`;
  const dateErrorId = `${uid}-date-err`;
  const memoHintId = `${uid}-memo-hint`;
  const memoErrorId = `${uid}-memo-err`;

  // Auto-fill first OSM candidate if creating new spot with generic placeholder and user hasn't typed
  useEffect(() => {
    if (
      mode === 'create-spot' &&
      osmCandidates.length > 0 &&
      !hasUserEditedNameRef.current &&
      (!initialName || initialName.startsWith('登録地点'))
    ) {
      setName(osmCandidates[0].name.slice(0, MAX_SPOT_NAME_LENGTH));
      if (osmCandidates[0].suggestedSpotCategory) {
        setCategory(osmCandidates[0].suggestedSpotCategory);
      }
    }
  }, [mode, osmCandidates, initialName]);

  // Compute field validation errors
  const nameError = useMemo(() => {
    if (!showSpotMeta) return null;
    const trimmed = sanitizeSpotName(name);
    if (!trimmed) return '地点名を入力してください。';
    if (name.length > MAX_SPOT_NAME_LENGTH) {
      return `地点名は${MAX_SPOT_NAME_LENGTH}文字以内で入力してください。`;
    }
    if (hasControlCharacters(name, false)) {
      return '地点名に使用できない制御文字が含まれています。';
    }
    return null;
  }, [showSpotMeta, name]);

  const dateValidation = useMemo(() => {
    if (!showEntryFields) return { ok: true as const, value: undefined, error: null, target: null };
    const res = normalizeVisitDate({
      precision,
      start: precision === 'none' ? undefined : startVal,
      end: precision !== 'none' && useRange ? endVal : undefined,
    });
    if (res.ok) return { ok: true as const, value: res.value, error: null, target: null };
    const isEndErr = res.error.includes('終了');
    return {
      ok: false as const,
      value: undefined,
      error: res.error,
      target: isEndErr ? ('end' as const) : ('start' as const),
    };
  }, [showEntryFields, precision, startVal, useRange, endVal]);

  const memoError = useMemo(() => {
    if (!showEntryFields) return null;
    if (memo.length > MAX_MEMO_LENGTH) {
      return `メモは${MAX_MEMO_LENGTH}文字以内で入力してください。`;
    }
    if (hasControlCharacters(memo, true)) {
      return 'メモに使用できない制御文字が含まれています。';
    }
    return null;
  }, [showEntryFields, memo]);

  // Sync HTML5 constraint validity for end-after-start cross-field validation
  useEffect(() => {
    if (endInputRef.current) {
      endInputRef.current.setCustomValidity(
        dateValidation.target === 'end' && dateValidation.error ? dateValidation.error : ''
      );
    }
    if (startInputRef.current) {
      startInputRef.current.setCustomValidity(
        dateValidation.target === 'start' && dateValidation.error ? dateValidation.error : ''
      );
    }
  }, [dateValidation]);

  const showNameErr = Boolean(nameError && (touched.name || submitAttempted));
  const showStartErr = Boolean(
    dateValidation.error &&
      dateValidation.target === 'start' &&
      (touched.start || submitAttempted)
  );
  const showEndErr = Boolean(
    dateValidation.error &&
      dateValidation.target === 'end' &&
      (touched.end || submitAttempted)
  );
  const showDateErr = showStartErr || showEndErr;
  const showMemoErr = Boolean(memoError && (touched.memo || submitAttempted));

  const handlePrecisionChange = (nextPrecision: VisitDatePrecision) => {
    setPrecision(nextPrecision);
    if (nextPrecision === 'none') {
      setStartVal('');
      setEndVal('');
      setUseRange(false);
      return;
    }
    if (nextPrecision === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(startVal)) {
      setStartVal(getTodayDateString());
      setEndVal('');
    } else if (nextPrecision === 'month' && !/^\d{4}-\d{2}$/.test(startVal)) {
      setStartVal(startVal.length >= 7 ? startVal.slice(0, 7) : getCurrentMonthString());
      setEndVal(endVal.length >= 7 ? endVal.slice(0, 7) : '');
    } else if (nextPrecision === 'year' && !/^\d{4}$/.test(startVal)) {
      setStartVal(
        startVal.length >= 4 ? startVal.slice(0, 4) : String(new Date().getFullYear())
      );
      setEndVal(endVal.length >= 4 ? endVal.slice(0, 4) : '');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);

    if (nameError) {
      nameInputRef.current?.focus();
      return;
    }
    if (!dateValidation.ok) {
      if (dateValidation.target === 'end') endInputRef.current?.focus();
      else startInputRef.current?.focus();
      return;
    }
    if (memoError) {
      memoInputRef.current?.focus();
      return;
    }

    await onSubmit({
      name: showSpotMeta ? sanitizeSpotName(name) : undefined,
      category: showSpotMeta ? category : undefined,
      isPinned: showSpotMeta ? isPinned : undefined,
      kind: showEntryFields ? kind : undefined,
      date: showEntryFields ? dateValidation.value : undefined,
      memo: showEntryFields ? sanitizeMemo(memo) : undefined,
    });
  };

  const submitLabel =
    mode === 'create-spot'
      ? '登録して保存'
      : mode === 'edit-spot'
        ? '地点情報を更新'
        : mode === 'convert-to-visited'
          ? '訪問済みとして保存'
          : mode === 'add-entry'
            ? '記録を追加'
            : '記録を更新';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3 text-xs">
      {showSpotMeta && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${uid}-name`} className="font-semibold text-slate-200">
              地点名 <span className="text-rose-400">*</span>
            </label>
            <span id={nameHintId} className="text-[11px] text-slate-400">
              最大 {MAX_SPOT_NAME_LENGTH} 文字
            </span>
          </div>
          <input
            ref={nameInputRef}
            id={`${uid}-name`}
            type="text"
            required
            maxLength={MAX_SPOT_NAME_LENGTH}
            value={name}
            onChange={(e) => {
              hasUserEditedNameRef.current = true;
              setName(e.target.value);
            }}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            aria-invalid={showNameErr ? 'true' : 'false'}
            aria-describedby={showNameErr ? `${nameHintId} ${nameErrorId}` : nameHintId}
            placeholder="例: 上高地、エッフェル塔"
            className={`visit-input w-full px-3 py-2 rounded-xl bg-slate-950/90 border text-base sm:text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-400 ${
              showNameErr ? 'user-invalid-fallback border-rose-400' : 'border-slate-700'
            }`}
          />
          {showNameErr && (
            <p id={nameErrorId} className="flex items-center gap-1 text-[11px] text-rose-300">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-label="エラー" />
              <span>{nameError}</span>
            </p>
          )}

          {mode === 'create-spot' && (isLoadingOsm || osmCandidates.length > 0) && (
            <div className="pt-1 space-y-1">
              <div className="flex items-center gap-1 text-[11px] text-slate-400">
                <Sparkles className="w-3 h-3 text-sky-400" aria-hidden="true" />
                <span>周辺の施設・地名候補</span>
                {isLoadingOsm && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {osmCandidates.map((cand) => (
                  <button
                    key={`${cand.source}-${cand.name}`}
                    type="button"
                    onClick={() => {
                      hasUserEditedNameRef.current = true;
                      setName(cand.name.slice(0, MAX_SPOT_NAME_LENGTH));
                      if (cand.suggestedSpotCategory) setCategory(cand.suggestedSpotCategory);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800/90 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-200 cursor-pointer"
                  >
                    <span className="font-medium">{cand.name}</span>
                    <span className="text-[10px] text-slate-400">
                      {cand.category}
                      {cand.distanceMeters !== undefined
                        ? ` · ${formatDistanceLabel(cand.distanceMeters)}`
                        : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="pt-1">
            <span className="block font-semibold text-slate-200 mb-1.5">カテゴリ</span>
            <div className="grid grid-cols-4 gap-1.5">
              {SPOT_CATEGORY_LIST.map((cat) => {
                const Icon = cat.icon;
                const active = category === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCategory(cat.id)}
                    className={`flex flex-col items-center justify-center gap-0.5 py-2 px-1 rounded-xl border text-[11px] font-semibold transition-colors cursor-pointer ${
                      active
                        ? cat.activeBgClass
                        : 'bg-slate-950/70 border-slate-800 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{cat.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-center gap-2 pt-1 text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isPinned}
              onChange={(e) => setIsPinned(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-slate-900 accent-sky-500"
            />
            <span>一覧の上位にピン留めする</span>
          </label>
        </div>
      )}

      {showEntryFields && (
        <div className="space-y-2.5 pt-1 border-t border-slate-800/80">
          {mode !== 'convert-to-visited' && (
            <div>
              <span className="block font-semibold text-slate-200 mb-1.5">記録ステータス</span>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  id="form-kind-visited"
                  aria-pressed={kind === 'visited'}
                  onClick={() => {
                    setKind('visited');
                    if (precision === 'none' && mode === 'create-spot') {
                      setPrecision('day');
                      setStartVal(getTodayDateString());
                    }
                  }}
                  className={`flex items-center justify-center gap-1.5 py-2 rounded-xl border font-semibold cursor-pointer ${
                    kind === 'visited'
                      ? 'bg-emerald-600/90 border-emerald-400 text-white'
                      : 'bg-slate-950/70 border-slate-800 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>訪問済み</span>
                </button>
                <button
                  type="button"
                  id="form-kind-planned"
                  aria-pressed={kind === 'planned'}
                  onClick={() => setKind('planned')}
                  className={`flex items-center justify-center gap-1.5 py-2 rounded-xl border font-semibold cursor-pointer ${
                    kind === 'planned'
                      ? 'bg-amber-600/90 border-amber-400 text-white'
                      : 'bg-slate-950/70 border-slate-800 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>訪問予定</span>
                </button>
              </div>
            </div>
          )}

          {/* 日付・From-To期間入力 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-200">日付・期間</span>
              {precision !== 'none' && (
                <label className="inline-flex items-center gap-1.5 text-[11px] text-sky-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useRange}
                    onChange={(e) => {
                      setUseRange(e.target.checked);
                      if (!e.target.checked) setEndVal('');
                    }}
                    className="w-3.5 h-3.5 accent-sky-400"
                  />
                  <span>期間（From - To）を指定</span>
                </label>
              )}
            </div>

            <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-slate-950/90 border border-slate-800">
              {PRECISION_LABELS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={precision === opt.id}
                  onClick={() => handlePrecisionChange(opt.id)}
                  className={`py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer ${
                    precision === opt.id
                      ? 'bg-sky-500/25 text-sky-200 border border-sky-400/50'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {precision !== 'none' && (
              <div className="space-y-1.5">
                <span id={startHintId} className="block text-[11px] text-slate-400">
                  {precision === 'day'
                    ? '形式: YYYY-MM-DD（開始日 〜 任意で終了日）'
                    : precision === 'month'
                      ? '形式: YYYY-MM（開始月 〜 任意で終了月）'
                      : '形式: YYYY（1900〜2100）'}
                </span>
                <div className={`grid gap-2 ${useRange ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  <div>
                    <label
                      htmlFor={`${uid}-date-start`}
                      className="block text-[11px] text-slate-300 mb-0.5"
                    >
                      {useRange ? '開始（From）' : '日付'}
                    </label>
                    {precision === 'year' ? (
                      <input
                        ref={startInputRef}
                        id={`${uid}-date-start`}
                        type="number"
                        min={1900}
                        max={2100}
                        required
                        value={startVal}
                        onChange={(e) => setStartVal(e.target.value)}
                        onBlur={() => setTouched((t) => ({ ...t, start: true }))}
                        aria-invalid={showStartErr ? 'true' : 'false'}
                        aria-describedby={
                          showStartErr ? `${startHintId} ${dateErrorId}` : startHintId
                        }
                        className={`visit-input w-full px-2.5 py-1.5 rounded-xl bg-slate-950 border text-base sm:text-sm text-white ${
                          showStartErr ? 'user-invalid-fallback border-rose-400' : 'border-slate-700'
                        }`}
                      />
                    ) : (
                      <input
                        ref={startInputRef}
                        id={`${uid}-date-start`}
                        type={precision === 'day' ? 'date' : 'month'}
                        required
                        value={startVal}
                        onChange={(e) => setStartVal(e.target.value)}
                        onBlur={() => setTouched((t) => ({ ...t, start: true }))}
                        aria-invalid={showStartErr ? 'true' : 'false'}
                        aria-describedby={
                          showStartErr ? `${startHintId} ${dateErrorId}` : startHintId
                        }
                        className={`visit-input w-full px-2.5 py-1.5 rounded-xl bg-slate-950 border text-base sm:text-sm text-white ${
                          showStartErr ? 'user-invalid-fallback border-rose-400' : 'border-slate-700'
                        }`}
                      />
                    )}
                  </div>

                  {useRange && (
                    <div>
                      <label
                        htmlFor={`${uid}-date-end`}
                        className="block text-[11px] text-slate-300 mb-0.5"
                      >
                        終了（To）
                      </label>
                      {precision === 'year' ? (
                        <input
                          ref={endInputRef}
                          id={`${uid}-date-end`}
                          type="number"
                          min={1900}
                          max={2100}
                          value={endVal}
                          onChange={(e) => setEndVal(e.target.value)}
                          onBlur={() => setTouched((t) => ({ ...t, end: true }))}
                          aria-invalid={showEndErr ? 'true' : 'false'}
                          aria-describedby={
                            showEndErr ? `${startHintId} ${dateErrorId}` : startHintId
                          }
                          className={`visit-input w-full px-2.5 py-1.5 rounded-xl bg-slate-950 border text-base sm:text-sm text-white ${
                            showEndErr ? 'user-invalid-fallback border-rose-400' : 'border-slate-700'
                          }`}
                        />
                      ) : (
                        <input
                          ref={endInputRef}
                          id={`${uid}-date-end`}
                          type={precision === 'day' ? 'date' : 'month'}
                          value={endVal}
                          onChange={(e) => setEndVal(e.target.value)}
                          onBlur={() => setTouched((t) => ({ ...t, end: true }))}
                          aria-invalid={showEndErr ? 'true' : 'false'}
                          aria-describedby={
                            showEndErr ? `${startHintId} ${dateErrorId}` : startHintId
                          }
                          className={`visit-input w-full px-2.5 py-1.5 rounded-xl bg-slate-950 border text-base sm:text-sm text-white ${
                            showEndErr ? 'user-invalid-fallback border-rose-400' : 'border-slate-700'
                          }`}
                        />
                      )}
                    </div>
                  )}
                </div>
                {showDateErr && (
                  <p id={dateErrorId} className="flex items-center gap-1 text-[11px] text-rose-300">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-label="エラー" />
                    <span>{dateValidation.error}</span>
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 複数行メモ */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`${uid}-memo`} className="font-semibold text-slate-200">
                メモ（任意・複数行可）
              </label>
              <span id={memoHintId} className="text-[11px] text-slate-400 tabular-nums">
                {memo.length} / {MAX_MEMO_LENGTH}
              </span>
            </div>
            <textarea
              ref={memoInputRef}
              id={`${uid}-memo`}
              rows={3}
              maxLength={MAX_MEMO_LENGTH}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, memo: true }))}
              aria-invalid={showMemoErr ? 'true' : 'false'}
              aria-describedby={showMemoErr ? `${memoHintId} ${memoErrorId}` : memoHintId}
              placeholder={
                kind === 'visited'
                  ? '感想、景色、アクセス手段、季節など...'
                  : '行きたい理由、準備・持ち物、季節の目安など...'
              }
              className={`visit-input w-full px-3 py-2 rounded-xl bg-slate-950/90 border text-base sm:text-sm text-white placeholder:text-slate-500 resize-y focus:outline-none focus:ring-2 focus:ring-sky-400 ${
                showMemoErr ? 'user-invalid-fallback border-rose-400' : 'border-slate-700'
              }`}
            />
            {showMemoErr && (
              <p id={memoErrorId} className="flex items-center gap-1 text-[11px] text-rose-300">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-label="エラー" />
                <span>{memoError}</span>
              </p>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800/80">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold cursor-pointer disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
          <span>キャンセル</span>
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold shadow cursor-pointer disabled:opacity-50"
        >
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
          <span>{submitLabel}</span>
        </button>
      </div>
    </form>
  );
};
