import { getSupabaseClient } from '../client';
import type { AppNotification, NotificationType } from '@tricigo/types';

export const notificationService = {
  async registerPushToken(
    userId: string,
    token: string,
    platform: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('user_devices')
      .upsert(
        { user_id: userId, push_token: token, platform },
        { onConflict: 'user_id,push_token' },
      );
    if (error) throw error;
  },

  async removePushToken(userId: string, token: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('user_devices')
      .delete()
      .eq('user_id', userId)
      .eq('push_token', token);
    if (error) throw error;
  },

  async getDeviceTokens(userId: string): Promise<string[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('user_devices')
      .select('push_token')
      .eq('user_id', userId)
      .not('push_token', 'is', null);
    if (error) throw error;
    return (data ?? []).map((row: { push_token: string }) => row.push_token);
  },

  async sendPushNotification(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ successCount: number; errorCount: number }> {
    if (tokens.length === 0) {
      return { successCount: 0, errorCount: 0 };
    }

    const messages = tokens.map((token) => ({
      to: token,
      title,
      body,
      sound: 'default' as const,
      ...(data ? { data } : {}),
    }));

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        console.error(
          `[notification] Expo push API returned status ${response.status}`,
        );
        return { successCount: 0, errorCount: tokens.length };
      }

      const result = (await response.json()) as {
        data: Array<{ status: 'ok' | 'error'; id?: string; message?: string }>;
      };

      let successCount = 0;
      let errorCount = 0;
      for (const ticket of result.data) {
        if (ticket.status === 'ok') {
          successCount++;
        } else {
          errorCount++;
          console.warn(
            `[notification] Push ticket error: ${ticket.message ?? 'unknown'}`,
          );
        }
      }

      return { successCount, errorCount };
    } catch (err) {
      console.error('[notification] Failed to send push notifications:', err);
      return { successCount: 0, errorCount: tokens.length };
    }
  },

  async notifyUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const tokens = await this.getDeviceTokens(userId);
    if (tokens.length === 0) {
      return;
    }

    const { successCount, errorCount } = await this.sendPushNotification(
      tokens,
      title,
      body,
      data,
    );
    console.log(
      `[notification] notifyUser ${userId}: ${successCount} sent, ${errorCount} failed`,
    );
  },

  /**
   * Broadcast push notification to all users of a specific role, or all users.
   */
  async broadcastPush(
    title: string,
    body: string,
    targetType: 'all' | 'customers' | 'drivers',
    sentBy: string,
    data?: Record<string, string>,
  ): Promise<{ successCount: number; errorCount: number }> {
    const supabase = getSupabaseClient();

    // Build query based on target
    let query = supabase
      .from('user_devices')
      .select('push_token, users!inner(role)')
      .not('push_token', 'is', null);

    if (targetType === 'customers') {
      query = query.eq('users.role', 'customer');
    } else if (targetType === 'drivers') {
      query = query.eq('users.role', 'driver');
    }

    const { data: devices, error } = await query;
    if (error) throw error;

    const tokens = (devices ?? []).map((d: Record<string, unknown>) => d.push_token as string);

    const result = tokens.length > 0
      ? await this.sendPushNotification(tokens, title, body, data)
      : { successCount: 0, errorCount: 0 };

    // Log the notification
    await supabase.from('notification_log').insert({
      title,
      body,
      target_type: targetType,
      sent_by: sentBy,
      sent_count: result.successCount,
    });

    return result;
  },

  /**
   * Send push notification to a specific user and log it.
   * If a category is provided, checks the user's notification preferences first.
   */
  async sendToUser(
    userId: string,
    title: string,
    body: string,
    sentBy: string,
    data?: Record<string, string>,
    category?: 'ride_updates' | 'chat_messages' | 'promotions' | 'payment_updates' | 'driver_approval',
  ): Promise<{ successCount: number; errorCount: number }> {
    const supabase = getSupabaseClient();

    // Check notification preferences if a category is provided
    if (category) {
      try {
        const prefs = await this.getPreferences(userId);
        if (prefs && prefs[category] === false) {
          // User has disabled this notification category — skip sending
          return { successCount: 0, errorCount: 0 };
        }
      } catch {
        // If preferences check fails, send the notification anyway
      }
    }

    const tokens = await this.getDeviceTokens(userId);

    const result = tokens.length > 0
      ? await this.sendPushNotification(tokens, title, body, data)
      : { successCount: 0, errorCount: 0 };

    await supabase.from('notification_log').insert({
      title,
      body,
      target_type: 'user',
      target_user_id: userId,
      sent_by: sentBy,
      sent_count: result.successCount,
    });

    return result;
  },

  /**
   * Send notification to multiple users (e.g., nearby drivers for a new ride).
   */
  async sendToMultipleUsers(
    userIds: string[],
    category: string,
    options: { title: string; body: string; data?: Record<string, string> },
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const userId of userIds) {
      try {
        await this.sendToUser(userId, options.title, options.body, 'system', options.data);
        sent++;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  },

  /**
   * Get notification history for admin panel.
   */
  async getNotificationHistory(
    page = 0,
    pageSize = 20,
  ): Promise<Array<{
    id: string;
    title: string;
    body: string;
    target_type: string;
    target_user_id: string | null;
    sent_by: string;
    sent_count: number;
    created_at: string;
  }>> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('notification_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as Array<{
      id: string;
      title: string;
      body: string;
      target_type: string;
      target_user_id: string | null;
      sent_by: string;
      sent_count: number;
      created_at: string;
    }>;
  },

  /**
   * Get a user's email address.
   */
  async getUserEmail(userId: string): Promise<string | null> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('users')
      .select('email')
      .eq('id', userId)
      .single();
    return data?.email ?? null;
  },

  /**
   * Send an email via the send-email Edge Function.
   */
  async sendEmail(params: {
    template: string;
    data: Record<string, unknown>;
    recipientEmail: string;
    subject: string;
    locale?: 'en' | 'es';
  }): Promise<{ success: boolean }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('send-email', {
      body: {
        template: params.template,
        data: params.data,
        recipient_email: params.recipientEmail,
        subject: params.subject,
        locale: params.locale ?? 'es',
      },
    });
    if (error) throw error;
    return (data as { success: boolean }) ?? { success: false };
  },

  /**
   * Send an SMS via the send-sms Edge Function.
   * Only sends if user has sms_notifications_enabled = true.
   */
  async sendSMS(params: {
    userId: string;
    body: string;
    rideId?: string;
    eventType?: string;
  }): Promise<{ success: boolean }> {
    const supabase = getSupabaseClient();

    // Check user phone and SMS preference
    const { data: user } = await supabase
      .from('users')
      .select('phone, sms_notifications_enabled')
      .eq('id', params.userId)
      .single();

    if (!user?.phone || !user.sms_notifications_enabled) {
      return { success: false };
    }

    const { data, error } = await supabase.functions.invoke('send-sms', {
      body: {
        user_id: params.userId,
        phone: user.phone,
        body: params.body,
        ride_id: params.rideId,
        event_type: params.eventType,
      },
    });
    if (error) throw error;
    return (data as { success: boolean }) ?? { success: false };
  },

  /**
   * Update SMS notification preference for a user.
   */
  async updateSmsPreference(userId: string, enabled: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('users')
      .update({ sms_notifications_enabled: enabled })
      .eq('id', userId);
    if (error) throw error;
  },

  /**
   * Get SMS notification preference for a user.
   */
  async getSmsPreference(userId: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('users')
      .select('sms_notifications_enabled')
      .eq('id', userId)
      .single();
    return data?.sms_notifications_enabled ?? false;
  },

  // ============================================================
  // Trusted Contact Notifications (Safety Sharing)
  // ============================================================

  /**
   * Send an SMS directly to a phone number via the send-sms Edge Function.
   * Used for trusted contacts who may not be registered users.
   * Fire-and-forget — callers should .catch(() => {}).
   */
  async sendSMSToPhone(params: {
    phone: string;
    body: string;
    eventType?: string;
  }): Promise<{ success: boolean }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('send-sms', {
      body: {
        phone: params.phone,
        body: params.body,
        event_type: params.eventType ?? 'trusted_contact',
      },
    });
    if (error) throw error;
    return (data as { success: boolean }) ?? { success: false };
  },

  /**
   * Notify all auto-share trusted contacts about a trip event via SMS.
   * Best-effort: failures are silently ignored per-contact.
   */
  async notifyTrustedContacts(params: {
    contacts: Array<{ name: string; phone: string }>;
    message: string;
    eventType?: string;
  }): Promise<void> {
    const promises = params.contacts.map((contact) =>
      this.sendSMSToPhone({
        phone: contact.phone,
        body: params.message,
        eventType: params.eventType ?? 'trusted_contact',
      }).catch(() => {}),
    );
    await Promise.allSettled(promises);
  },

  // ============================================================
  // Push Notification Preferences
  // ============================================================

  async getPreferences(userId: string) {
    const supabase = getSupabaseClient();
    const { data } = await supabase.rpc('ensure_notification_preferences', { p_user_id: userId });
    return data as {
      id: string;
      user_id: string;
      ride_updates: boolean;
      chat_messages: boolean;
      promotions: boolean;
      payment_updates: boolean;
      driver_approval: boolean;
      created_at: string;
      updated_at: string;
    } | null;
  },

  async updatePreferences(userId: string, prefs: Partial<{
    ride_updates: boolean;
    chat_messages: boolean;
    promotions: boolean;
    payment_updates: boolean;
    driver_approval: boolean;
  }>) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('notification_preferences')
      .update({ ...prefs, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Send ride receipt email to customer (non-critical, fails silently).
   */
  async sendRideReceipt(rideId: string, customerId: string): Promise<void> {
    try {
      const email = await this.getUserEmail(customerId);
      if (!email) return;

      const supabase = getSupabaseClient();
      const { data: ride } = await supabase
        .from('rides')
        .select('*')
        .eq('id', rideId)
        .single();
      if (!ride) return;

      await this.sendEmail({
        template: 'ride_receipt',
        data: ride as Record<string, unknown>,
        recipientEmail: email,
        subject: 'Tu recibo de viaje TriciGo',
        locale: 'es',
      });
    } catch {
      // Email is non-critical, fail silently
    }
  },

  // ============================================================
  // In-App Notification Inbox
  // ============================================================

  /**
   * Get paginated inbox notifications for a user.
   */
  async getInboxNotifications(
    userId: string,
    options: { unreadOnly?: boolean; limit?: number; offset?: number } = {},
  ): Promise<AppNotification[]> {
    const supabase = getSupabaseClient();
    const { unreadOnly = false, limit = 20, offset = 0 } = options;

    let query = supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId);

    if (unreadOnly) {
      query = query.eq('read', false);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as AppNotification[];
  },

  /**
   * Get unread notification count for badge display.
   */
  async getUnreadCount(userId: string): Promise<number> {
    const supabase = getSupabaseClient();
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false);
    if (error) throw error;
    return count ?? 0;
  },

  /**
   * Mark a single notification as read.
   */
  async markAsRead(notificationId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', notificationId);
    if (error) throw error;
  },

  /**
   * Mark all notifications as read for a user.
   */
  async markAllAsRead(userId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false);
    if (error) throw error;
  },

  /**
   * Create an inbox notification directly (without sending push).
   * Useful for programmatic notifications from services.
   */
  async createInboxNotification(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<AppNotification> {
    const supabase = getSupabaseClient();
    const { data: row, error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        type,
        title,
        body,
        data: data ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return row as AppNotification;
  },

  /**
   * Subscribe to real-time inbox notifications for a user.
   * Follows the same pattern as chatService.subscribeToMessages().
   */
  subscribeToNotifications(
    userId: string,
    onNotification: (notification: AppNotification) => void,
  ) {
    const supabase = getSupabaseClient();
    return supabase
      .channel(`inbox:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          onNotification(payload.new as AppNotification);
        },
      )
      .subscribe();
  },
};
