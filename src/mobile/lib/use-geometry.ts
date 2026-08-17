import { useCallback, useEffect, useState } from 'react';
import { getGeometry, type MobileGeometry } from './geometry';
import type { MobileFeature } from './catalog';

export interface GeometryState {
  result: MobileGeometry | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Fetches the boundary for whichever feature is on screen.
 *
 * Aborts on unmount and on a change of feature, which matters more here than it would on a
 * desktop: tapping through four search results on a phone would otherwise leave four
 * downloads running against four services, on a connection that has room for about one.
 */
export function useGeometry(feature: MobileFeature | null): GeometryState {
  const [result, setResult] = useState<MobileGeometry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const featureId = feature?.id ?? null;

  useEffect(() => {
    if (!feature) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError(null);

    getGeometry(feature, controller.signal)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // featureId rather than the object: a re-render that rebuilds the candidate list must
    // not restart a download that is already most of the way through.
  }, [featureId, attempt]);

  return { result, loading, error, retry };
}
