// ============================================================
// TriciGo — In-App Notification Types
// ============================================================

export type NotificationType =
  | 'ride_update'
  | 'ride_completed'
  | 'ride_canceled'
  | 'driver_assigned'
  | 'driver_arriving'
  | 'dispute_update'
  | 'wallet_credit'
  | 'wallet_debit'
  | 'promo'
  | 'referral_reward'
  | 'quest_completed'
  | 'system';

export interface AppNotification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}
