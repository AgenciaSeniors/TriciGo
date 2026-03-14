/**
 * Quick-reply presets for ride chat.
 * Each preset has an i18n key suffix, Ionicons icon name, and allowed roles.
 */

export interface QuickReply {
  /** Suffix appended to `chat.quick_` for the i18n key */
  key: string;
  /** Ionicons icon name */
  icon: string;
  /** Roles that can see this quick reply */
  roles: ('rider' | 'driver')[];
}

export const QUICK_REPLIES: QuickReply[] = [
  { key: 'arriving', icon: 'car-outline', roles: ['driver'] },
  { key: 'at_door', icon: 'location', roles: ['driver'] },
  { key: 'five_more_min', icon: 'time-outline', roles: ['driver', 'rider'] },
  { key: 'on_my_way', icon: 'walk-outline', roles: ['rider'] },
  { key: 'wait_please', icon: 'hand-left-outline', roles: ['rider'] },
  { key: 'thank_you', icon: 'heart-outline', roles: ['driver', 'rider'] },
];

/**
 * Returns quick-reply presets filtered by role.
 */
export function getQuickRepliesForRole(role: 'rider' | 'driver'): QuickReply[] {
  return QUICK_REPLIES.filter((qr) => qr.roles.includes(role));
}
