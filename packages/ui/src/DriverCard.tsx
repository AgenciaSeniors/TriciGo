import React from 'react';
import { View, Image as RNImage } from 'react-native';
import { Image } from 'expo-image';
import type { ImageSourcePropType } from 'react-native';
import { Text } from './Text';
import { Card } from './Card';
import { Avatar } from './Avatar';

export interface DriverCardProps {
  /** Driver display name */
  driverName: string;
  /** Avatar URL from Supabase Storage */
  driverAvatarUrl?: string | null;
  /** Average rating (1-5) */
  driverRating?: number | null;
  /** Total completed rides */
  driverTotalRides?: number | null;
  /** Vehicle make (e.g. "Honda") */
  vehicleMake?: string | null;
  /** Vehicle model (e.g. "Wave") */
  vehicleModel?: string | null;
  /** Vehicle color */
  vehicleColor?: string | null;
  /** License plate */
  vehiclePlate?: string | null;
  /** Vehicle photo URL from Supabase Storage */
  vehiclePhotoUrl?: string | null;
  /** Vehicle manufacturing year */
  vehicleYear?: number | null;
  /** Action buttons (e.g. chat, call, SOS) rendered on the right side */
  actions?: React.ReactNode;
  /** Compact mode: smaller avatar (40px), no vehicle photo */
  compact?: boolean;
  /** Localized label for ride count */
  ridesLabel?: string;
  /** Service type icon (e.g. triciclo, moto, auto) shown next to vehicle info */
  serviceTypeIcon?: ImageSourcePropType;
}

export function DriverCard({
  driverName,
  driverAvatarUrl,
  driverRating,
  driverTotalRides,
  vehicleMake,
  vehicleModel,
  vehicleColor,
  vehiclePlate,
  vehiclePhotoUrl,
  vehicleYear,
  actions,
  compact = false,
  ridesLabel = 'viajes',
  serviceTypeIcon,
}: DriverCardProps) {
  const avatarSize = compact ? 40 : 60;

  // Build vehicle description line: "2021 Honda Wave · Azul"
  const vehicleParts: string[] = [];
  if (vehicleYear) vehicleParts.push(String(vehicleYear));
  if (vehicleMake) vehicleParts.push(vehicleMake);
  if (vehicleModel) vehicleParts.push(vehicleModel);
  const vehicleDesc = vehicleParts.join(' ');
  const vehicleLine = vehicleColor
    ? `${vehicleDesc} · ${vehicleColor}`
    : vehicleDesc;

  // Rating + rides line: "★ 4.8 · 312 viajes"
  const ratingParts: string[] = [];
  if (driverRating != null) {
    ratingParts.push(`★ ${driverRating.toFixed(1)}`);
  }
  if (driverTotalRides != null && driverTotalRides > 0) {
    ratingParts.push(`${driverTotalRides} ${ridesLabel}`);
  }
  const ratingLine = ratingParts.join(' · ');

  return (
    <Card variant="elevated" padding="md">
      <View className="flex-row items-start">
        {/* Avatar */}
        <View className="mr-3">
          <Avatar
            uri={driverAvatarUrl}
            size={avatarSize}
            name={driverName}
          />
        </View>

        {/* Info */}
        <View className="flex-1" accessible accessibilityLabel={[driverName, ratingLine, vehicleLine, vehiclePlate ? `plate ${vehiclePlate}` : ''].filter(Boolean).join(', ')}>
          <Text variant={compact ? 'body' : 'h4'} className="font-semibold">
            {driverName}
          </Text>

          {ratingLine.length > 0 && (
            <Text variant="caption" color="secondary" className="mt-0.5">
              {ratingLine}
            </Text>
          )}

          {vehicleLine.length > 0 && (
            <View className="flex-row items-center mt-1">
              {serviceTypeIcon && (
                <RNImage
                  source={serviceTypeIcon}
                  style={{ width: 24, height: 24, marginRight: 6 }}
                  resizeMode="contain"
                />
              )}
              <Text variant="bodySmall" color="secondary">
                {vehicleLine}
              </Text>
            </View>
          )}

          {vehiclePlate && (
            <View className="self-start bg-neutral-100 rounded-lg px-3 py-1 mt-2">
              <Text variant="label" color="accent">
                {vehiclePlate}
              </Text>
            </View>
          )}
        </View>

        {/* Action buttons */}
        {actions && (
          <View className="flex-row gap-2 ml-2">
            {actions}
          </View>
        )}
      </View>

      {/* Vehicle photo (full width, only in non-compact mode) */}
      {!compact && vehiclePhotoUrl && (
        <View className="mt-3 rounded-lg overflow-hidden">
          <Image
            source={{ uri: vehiclePhotoUrl }}
            transition={300}
            style={{ width: '100%', aspectRatio: 16 / 9 }}
            contentFit="cover"
          />
        </View>
      )}
    </Card>
  );
}
