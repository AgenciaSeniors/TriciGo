import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { DriverProfileScreen } from '@/components/DriverProfileScreen';

export default function DriverProfilePage() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  return <DriverProfileScreen driverUserId={userId} />;
}
