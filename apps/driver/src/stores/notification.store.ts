import { create } from 'zustand';
import type { AppNotification } from '@tricigo/types';

interface NotificationState {
  unreadCount: number;
  notifications: AppNotification[];
  isLoading: boolean;

  setUnreadCount: (count: number) => void;
  incrementUnread: () => void;
  decrementUnread: (by?: number) => void;
  setNotifications: (items: AppNotification[]) => void;
  appendNotifications: (items: AppNotification[]) => void;
  prependNotification: (item: AppNotification) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  unreadCount: 0,
  notifications: [],
  isLoading: false,

  setUnreadCount: (count) => set({ unreadCount: count }),
  incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
  decrementUnread: (by = 1) =>
    set((s) => ({ unreadCount: Math.max(0, s.unreadCount - by) })),
  setNotifications: (items) => set({ notifications: items }),
  appendNotifications: (items) =>
    set((s) => ({ notifications: [...s.notifications, ...items] })),
  prependNotification: (item) =>
    set((s) => ({
      notifications: [item, ...s.notifications],
    })),
  markRead: (id) =>
    set((s) => ({
      notifications: s.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n,
      ),
    })),
  markAllRead: () =>
    set((s) => ({
      unreadCount: 0,
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
    })),
  setLoading: (loading) => set({ isLoading: loading }),
  reset: () => set({ unreadCount: 0, notifications: [], isLoading: false }),
}));
