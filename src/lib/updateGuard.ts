import { useEffect } from 'react';

const blockers = new Set<symbol>();

export function isUpdateBlocked(): boolean {
  return blockers.size > 0;
}

export function useUpdateBlocker(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const token = Symbol();
    blockers.add(token);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('visit3d-update-state'));
    }
    return () => {
      blockers.delete(token);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('visit3d-update-state'));
      }
    };
  }, [active]);
}
