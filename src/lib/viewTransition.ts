import { flushSync } from 'react-dom';

export type ViewTransitionCallback = () => Promise<void> | void;

let latestTransition = 0;

/**
 * View Transitions API ラッパー（未対応・prefers-reduced-motion では同期フォールバック）
 */
export function runViewTransition(
  callback: ViewTransitionCallback,
  options?: { focusTargetSelector?: string }
): void {
  const generation = ++latestTransition;
  const reportFailure = (phase: string, error: unknown) => {
    console.error(`View transition ${phase} failed:`, error);
  };
  const applyFocus = () => {
    if (
      generation !== latestTransition ||
      typeof document === 'undefined' ||
      document.visibilityState === 'hidden'
    ) {
      return;
    }
    if (options?.focusTargetSelector) {
      const target = document.querySelector<HTMLElement>(options.focusTargetSelector);
      if (
        target?.isConnected &&
        !target.closest('[hidden], [inert], [aria-hidden="true"]') &&
        !target.matches(':disabled') &&
        target.getClientRects().length > 0
      ) {
        target.focus({ preventScroll: true });
      }
    }
  };

  let updateStarted = false;
  const update = () => {
    updateStarted = true;
    let result: ReturnType<ViewTransitionCallback> = undefined;
    flushSync(() => {
      result = callback();
    });
    return result;
  };
  const withoutAnimation = () => {
    try {
      void Promise.resolve(update())
        .then(applyFocus, (error) => reportFailure('update', error))
        .catch((error) => reportFailure('focus', error));
    } catch (error) {
      reportFailure('update', error);
    }
  };

  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') {
    withoutAnimation();
    return;
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    withoutAnimation();
    return;
  }

  try {
    const transition = document.startViewTransition(update);
    void Promise.allSettled([transition.ready, transition.updateCallbackDone, transition.finished])
      .then(([ready, updated, finished]) => {
        if (updated.status === 'rejected') {
          reportFailure('update', updated.reason);
          return;
        }
        if (finished.status === 'rejected') {
          reportFailure('completion', finished.reason);
          return;
        }
        if (ready.status === 'rejected' && ready.reason?.name !== 'AbortError') {
          reportFailure('animation', ready.reason);
        }
        applyFocus();
      })
      .catch((error) => reportFailure('focus', error));
  } catch (error) {
    reportFailure('start', error);
    if (!updateStarted) withoutAnimation();
  }
}
