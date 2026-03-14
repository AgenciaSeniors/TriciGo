import React from 'react';
import { View, Image, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';

export interface AvatarProps {
  /** Image URI (Supabase Storage public URL) */
  uri?: string | null;
  /** Size in pixels (default 48) */
  size?: number;
  /** User name for initials fallback */
  name?: string;
  /** Callback when avatar is pressed */
  onPress?: () => void;
  /** Show camera badge for edit mode */
  showEditBadge?: boolean;
  /** Show loading spinner overlay */
  loading?: boolean;
}

/** Get initials from a name (max 2 chars) */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/** Deterministic color from name string */
function getColorFromName(name: string): string {
  const colors = [
    '#f97316', // orange
    '#3b82f6', // blue
    '#10b981', // emerald
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#14b8a6', // teal
    '#f59e0b', // amber
    '#6366f1', // indigo
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function Avatar({
  uri,
  size = 48,
  name,
  onPress,
  showEditBadge = false,
  loading = false,
}: AvatarProps) {
  const badgeSize = Math.max(20, Math.round(size * 0.35));
  const fontSize = Math.round(size * 0.38);

  const content = (
    <View
      className="rounded-full overflow-hidden items-center justify-center"
      style={{
        width: size,
        height: size,
        backgroundColor: uri ? '#e5e7eb' : name ? getColorFromName(name) : '#e5e7eb',
      }}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size }}
          resizeMode="cover"
        />
      ) : name ? (
        <Text
          variant="label"
          style={{ fontSize, color: '#ffffff', fontWeight: '600' }}
        >
          {getInitials(name)}
        </Text>
      ) : (
        <Ionicons name="person-circle" size={size} color="#9ca3af" />
      )}

      {/* Loading overlay */}
      {loading && (
        <View
          className="absolute inset-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
        >
          <ActivityIndicator color="#ffffff" size="small" />
        </View>
      )}
    </View>
  );

  return (
    <View style={{ width: size, height: size }}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          disabled={loading}
          accessibilityRole="imagebutton"
          accessibilityLabel={name ? `${name} avatar` : 'User avatar'}
          accessibilityState={{ disabled: loading }}
          accessibilityHint={showEditBadge ? 'Change profile photo' : undefined}
        >
          {content}
        </Pressable>
      ) : (
        <View
          accessibilityRole="image"
          accessibilityLabel={name ? `${name} avatar` : 'User avatar'}
        >
          {content}
        </View>
      )}

      {/* Edit badge */}
      {showEditBadge && (
        <View
          className="absolute items-center justify-center rounded-full bg-white"
          style={{
            width: badgeSize,
            height: badgeSize,
            bottom: 0,
            right: 0,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.2,
            shadowRadius: 2,
            elevation: 3,
          }}
        >
          <Ionicons name="camera" size={Math.round(badgeSize * 0.6)} color="#374151" />
        </View>
      )}
    </View>
  );
}
