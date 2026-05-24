import { useState, useCallback } from 'react';

interface SubmitPoiParams {
  name: string;
  tricigoCategory: string;
  lat: number;
  lng: number;
  address?: string | null;
  notes?: string | null;
}

interface SubmitResult {
  ok: boolean;
  submissionId?: string;
  nearbyExistingCount?: number;
  error?: string;
  retryAfterMinutes?: number;
}

/**
 * Supabase client interface — kept structural so the hook stays agnostic
 * of the client wrapper used by each app (apps pass their own client).
 * Mirrors the subset of `@supabase/supabase-js` Client.rpc we use.
 */
interface SupabaseLike {
  // PostgrestBuilder is a PromiseLike (thenable) but not a real Promise —
  // structural typing as PromiseLike keeps this hook compatible with the
  // @supabase/supabase-js Client.rpc() return shape.
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

/**
 * Hook for submitting a POI to the moderation queue.
 *
 * The submit_poi RPC enforces rate limits server-side (5/hour, 20/day per
 * user) — we surface them through the `error` field as `rate_limit_hour`
 * or `rate_limit_day` with `retryAfterMinutes`.
 *
 * Usage:
 *   const { submit, isSubmitting, lastResult } = useSubmitPoi(supabase);
 *   const result = await submit({ name, tricigoCategory, lat, lng });
 *   if (result.ok) showToast(t('poi.submitted_pending'));
 */
export function useSubmitPoi(supabase: SupabaseLike) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<SubmitResult | null>(null);

  const submit = useCallback(async (params: SubmitPoiParams): Promise<SubmitResult> => {
    setIsSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('submit_poi', {
        p_name: params.name,
        p_tricigo_category: params.tricigoCategory,
        p_lat: params.lat,
        p_lng: params.lng,
        p_address: params.address ?? null,
        p_notes: params.notes ?? null,
      });

      if (error) {
        const result: SubmitResult = { ok: false, error: error.message };
        setLastResult(result);
        return result;
      }

      const row = data as {
        submission_id?: string;
        nearby_existing_count?: number;
        error?: string;
        retry_after_minutes?: number;
      } | null;
      if (!row) {
        const r: SubmitResult = { ok: false, error: 'no_response' };
        setLastResult(r);
        return r;
      }
      if (row.error) {
        const r: SubmitResult = {
          ok: false,
          error: row.error,
          retryAfterMinutes: row.retry_after_minutes,
        };
        setLastResult(r);
        return r;
      }

      const result: SubmitResult = {
        ok: true,
        submissionId: row.submission_id,
        nearbyExistingCount: row.nearby_existing_count ?? 0,
      };
      setLastResult(result);
      return result;
    } catch (e) {
      const result: SubmitResult = {
        ok: false,
        error: String((e as { message?: string })?.message ?? e),
      };
      setLastResult(result);
      return result;
    } finally {
      setIsSubmitting(false);
    }
  }, [supabase]);

  return { submit, isSubmitting, lastResult };
}
