import { useAuthStore } from '@/stores/auth.store';

export function useAuth() {
  const user = useAuthStore((s) => s.user);
  return { userId: user?.id ?? null, user };
}
