import { useEffect, useState } from 'react';
import { corporateService } from '@tricigo/api';
import type { CorporateAccount } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';

export function useCorporateAccounts() {
  const user = useAuthStore((s) => s.user);
  const [accounts, setAccounts] = useState<CorporateAccount[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;

    let mounted = true;
    setLoading(true);

    corporateService
      .getMyAccounts(user.id)
      .then((data) => {
        if (mounted) setAccounts(data);
      })
      .catch(() => {
        // No corporate accounts
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [user]);

  return { accounts, loading };
}
