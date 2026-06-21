import { useCallback, useEffect, useState } from 'react';
import { corporateService } from '@tricigo/api';
import type { CorporateAccount } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';

export function useCorporateAccounts() {
  const user = useAuthStore((s) => s.user);
  const [accounts, setAccounts] = useState<CorporateAccount[]>([]);
  const [loading, setLoading] = useState(false);

  // Exposed so callers can re-fetch on focus / foreground (stale-on-mount:
  // an admin approving/denying a membership should reflect without a restart).
  const refetch = useCallback(() => {
    if (!user) return;
    setLoading(true);
    corporateService
      .getMyAccounts(user.id)
      .then((data) => setAccounts(data))
      .catch(() => {
        // No corporate accounts
      })
      .finally(() => setLoading(false));
  }, [user]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { accounts, loading, refetch };
}
