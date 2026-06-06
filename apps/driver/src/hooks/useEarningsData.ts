/**
 * useEarningsData — extracted from apps/driver/app/(tabs)/earnings.tsx
 * for PR-A.
 *
 * Encapsulates the entire earnings-screen fetch layer:
 *   - Critical (parallel): driver_cash balance, period trip history,
 *     commission_rate config, review summary.
 *   - Deferred (best-effort, after critical): quest progress + driver
 *     stats. Failures here don't block initial render.
 *   - Trend comparison (best-effort, after critical): previous-period
 *     trip history → totals.
 *   - Pagination of recent driver_cash transactions, gated by an
 *     external `expanded` flag so we only fetch when the user asks.
 *
 * Returns the same data shape the inline implementation owned, so the
 * orchestrator can keep its render code unchanged.
 *
 * Bug-for-bug behaviour preserved:
 *   - The original `onRefresh` reset transactions array but did NOT
 *     re-trigger the load (because `txPage` stayed at 0). We mirror
 *     that here: `refetch()` clears the list but waits for the next
 *     expand or page bump to actually re-fetch. Documented with a
 *     // BUG-marker comment for a follow-up PR.
 */
import { useCallback, useEffect, useState } from 'react';
import Toast from 'react-native-toast-message';
import { walletService } from '@tricigo/api/services/wallet';
import { driverService } from '@tricigo/api/services/driver';
import { reviewService } from '@tricigo/api/services/review';
import { questService } from '@tricigo/api/services/quest';
import type { Ride, QuestWithProgress, LedgerTransaction } from '@tricigo/types';
import { useDriverStore } from '@/stores/driver.store';
import { tripNetEarnings } from '@/utils/tripNetEarnings';

export type Period = 'day' | 'week' | 'month';

export type TransactionWithAmount = LedgerTransaction & {
  ledger_entries: { account_id: string; amount: number }[];
};

export interface DriverStats {
  acceptanceRate: number;
  cancellationRate: number;
  completionRate: number;
  ridesThisWeek: number;
  ridesThisMonth: number;
  avgResponseTimeS: number | null;
  matchScore: number;
}

export function getDateRange(period: Period): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  switch (period) {
    case 'day': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      return { start, end };
    }
    case 'week': {
      const dayOfWeek = now.getDay();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
      monday.setHours(0, 0, 0, 0);
      return { start: monday, end };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { start, end };
    }
  }
}

function getPreviousDateRange(period: Period): { start: Date; end: Date } {
  const current = getDateRange(period);
  const durationMs = current.end.getTime() - current.start.getTime();
  return {
    start: new Date(current.start.getTime() - durationMs - 1),
    end: new Date(current.start.getTime() - 1),
  };
}

interface UseEarningsDataArgs {
  userId: string | undefined;
  driverProfileId: string | undefined;
  period: Period;
  /** True when the recent-activity section is expanded — gates tx fetches. */
  txExpanded: boolean;
}

export interface UseEarningsDataResult {
  loading: boolean;
  refreshing: boolean;
  balance: number;
  periodTrips: Ride[];
  commissionRate: number;
  avgRating: number | null;
  totalReviews: number;
  totalTripsCount: number;
  todayEarnings: number;
  prevPeriodEarnings: number | null;
  quests: QuestWithProgress[];
  driverStats: DriverStats | null;
  transactions: TransactionWithAmount[];
  /** The driver's tricicoin account id — for per-account amount math in the UI. */
  txAccountId: string | null;
  txHasMore: boolean;
  txLoading: boolean;
  /** Load the next page of recent activity. */
  loadMoreTransactions: () => void;
  /** Pull-to-refresh handler. Resets transactions + refetches all primary data. */
  refetch: () => void;
}

export function useEarningsData({
  userId,
  driverProfileId,
  period,
  txExpanded,
}: UseEarningsDataArgs): UseEarningsDataResult {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [balance, setBalance] = useState(0);
  const [txAccountId, setTxAccountId] = useState<string | null>(null);
  const [periodTrips, setPeriodTrips] = useState<Ride[]>([]);
  const [commissionRate, setCommissionRate] = useState(0.15);
  const [avgRating, setAvgRating] = useState<number | null>(null);
  const [totalReviews, setTotalReviews] = useState(0);
  const [totalTripsCount, setTotalTripsCount] = useState(0);
  const [todayEarnings, setTodayEarnings] = useState(0);
  const [prevPeriodEarnings, setPrevPeriodEarnings] = useState<number | null>(null);
  const [quests, setQuests] = useState<QuestWithProgress[]>([]);
  const [driverStats, setDriverStats] = useState<DriverStats | null>(null);

  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [txPage, setTxPage] = useState(0);
  const [txHasMore, setTxHasMore] = useState(true);
  const [txLoading, setTxLoading] = useState(false);

  const fetchData = useCallback(async () => {
    if (!userId || !driverProfileId) return;
    try {
      const { start, end } = getDateRange(period);

      // Critical data — fetch in parallel (4 calls → renders immediately)
      const [balanceData, trips, commRateStr, ratingData] = await Promise.all([
        // 00300: single-wallet driver model. Antes leía driver_cash (-60k
        // de deuda backfilled BUG-211). Ahora lee tricicoin que es el
        // wallet único: recibe recargas NETOPIA + se debita comisión al
        // completar ride. Match con lo que muestra QuotaCard via
        // get_driver_quota_status que también lee tricicoin.
        walletService.getBalance(userId, 'tricicoin'),
        driverService.getTripHistoryByDateRange(
          driverProfileId,
          start.toISOString(),
          end.toISOString(),
        ),
        walletService.getConfigValue('commission_rate').catch(() => null),
        reviewService.getReviewSummary(userId).catch(() => null),
      ]);

      setBalance(balanceData.available);
      setPeriodTrips(trips);

      // Today's earnings — filter from existing data instead of a second API call.
      // BUG-fare-audit B5: sum NET (fare − commission + tip) via tripNetEarnings
      // so the dashboard total matches what the driver actually takes home.
      // Previously summed gross `final_fare_cup`, which misrepresented earnings
      // by ~15% (the commission) and ignored tips entirely.
      if (period === 'day') {
        let todayTotal = 0;
        for (const trip of trips) todayTotal += tripNetEarnings(trip, commissionRate);
        setTodayEarnings(todayTotal);
      } else {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        let todayTotal = 0;
        for (const trip of trips) {
          const completedAt = new Date(trip.completed_at ?? trip.created_at);
          if (completedAt >= todayStart) {
            todayTotal += tripNetEarnings(trip, commissionRate);
          }
        }
        setTodayEarnings(todayTotal);
      }

      const parsedRate = commRateStr ? parseFloat(String(commRateStr).replace(/"/g, '')) : NaN;
      setCommissionRate(!isNaN(parsedRate) && parsedRate > 0 && parsedRate < 1 ? parsedRate : 0.15);

      // Total trips — use cached profile from store (no extra API call)
      const driverProfileData = useDriverStore.getState().profile;
      setTotalTripsCount(driverProfileData?.total_rides_completed ?? driverProfileData?.total_rides ?? 0);

      if (ratingData) {
        setAvgRating(ratingData.average_rating);
        setTotalReviews(ratingData.total_reviews);
      }
    } catch (err) {
      console.error('Error fetching earnings:', err);
      Toast.show({ type: 'error', text1: 'Error cargando ganancias', text2: 'Desliza para reintentar' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }

    // Non-critical data — deferred (doesn't block initial render)
    try {
      const [questData, stats] = await Promise.all([
        questService.getDriverQuestProgress(driverProfileId).catch(() => null),
        driverService.getDriverStats(driverProfileId).catch(() => null),
      ]);
      if (questData) setQuests(questData);
      if (stats) setDriverStats(stats);
    } catch { /* non-critical */ }

    // Previous period for trend comparison — deferred
    try {
      const prev = getPreviousDateRange(period);
      const prevTrips = await driverService.getTripHistoryByDateRange(
        driverProfileId,
        prev.start.toISOString(),
        prev.end.toISOString(),
      );
      let prevTotal = 0;
      for (const trip of prevTrips) {
        // BUG-fare-audit B5: sum net (matches the today/dashboard accumulator).
        prevTotal += tripNetEarnings(trip, commissionRate);
      }
      setPrevPeriodEarnings(prevTotal);
    } catch {
      setPrevPeriodEarnings(null);
    }
  }, [userId, driverProfileId, period]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  const refetch = useCallback(() => {
    setRefreshing(true);
    // BUG (preserved verbatim): resetting txPage to 0 when it was already
    // 0 doesn't re-trigger the tx-load effect, so transactions appear
    // empty until the user expands or scrolls to "Ver mas". A follow-up
    // PR should reload transactions explicitly here.
    setTransactions([]);
    setTxPage(0);
    setTxHasMore(true);
    fetchData();
  }, [fetchData]);

  const loadTransactions = useCallback(async () => {
    if (!userId || txLoading) return;
    setTxLoading(true);
    try {
      // Driver wallet is `tricicoin` (single-wallet model since 00300). The old
      // `driver_cash` is the deprecated/frozen Gen-A wallet — reading it showed
      // stale entries while hiding ALL recent activity (tips, commissions, ride
      // payments, cargo bonus). Switch to tricicoin to match the main wallet.
      const account = await walletService.getAccount(userId, 'tricicoin');
      if (!account) return;
      setTxAccountId(account.id);
      const data = await walletService.getTransactions(account.id, txPage, 10);
      if (data.length < 10) setTxHasMore(false);
      setTransactions(prev =>
        txPage === 0 ? (data as TransactionWithAmount[]) : [...prev, ...(data as TransactionWithAmount[])],
      );
    } catch {
      // silent fail — non-critical
    } finally {
      setTxLoading(false);
    }
  }, [userId, txPage, txLoading]);

  // Load transactions when section is expanded or page changes — same
  // gating as the original useEffect on [txExpanded, txPage].
  useEffect(() => {
    if (txExpanded) {
      loadTransactions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txExpanded, txPage]);

  const loadMoreTransactions = useCallback(() => {
    setTxPage((p) => p + 1);
  }, []);

  return {
    loading,
    refreshing,
    balance,
    periodTrips,
    commissionRate,
    avgRating,
    totalReviews,
    totalTripsCount,
    todayEarnings,
    prevPeriodEarnings,
    quests,
    driverStats,
    transactions,
    txAccountId,
    txHasMore,
    txLoading,
    loadMoreTransactions,
    refetch,
  };
}
