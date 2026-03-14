import { useEffect, useState, useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { driverService } from '@tricigo/api';
import type { SelfieCheck } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';

export function useSelfieCheck() {
  const user = useAuthStore((s) => s.user);
  const driverProfileId = useAuthStore((s) => s.driverProfileId);
  const [check, setCheck] = useState<SelfieCheck | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch latest selfie check on mount
  useEffect(() => {
    if (!driverProfileId) return;
    let mounted = true;

    driverService
      .getLatestSelfieCheck(driverProfileId)
      .then((data) => {
        if (mounted && data) setCheck(data);
      })
      .catch(() => {});

    return () => { mounted = false; };
  }, [driverProfileId]);

  const needsCheck = check?.status === 'pending' || check?.status === 'failed';
  const isProcessing = check?.status === 'processing';

  const submitSelfie = useCallback(async () => {
    if (!driverProfileId) return;

    setLoading(true);
    try {
      // Ensure there's a pending check
      let activeCheck = check;
      if (!activeCheck || activeCheck.status !== 'pending') {
        activeCheck = await driverService.requestSelfieCheck(driverProfileId);
        setCheck(activeCheck);
      }

      // Open camera
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        quality: 0.8,
        allowsEditing: false,
        cameraType: ImagePicker.CameraType.front,
      });

      if (result.canceled || !result.assets?.[0]) {
        setLoading(false);
        return;
      }

      const asset = result.assets[0];
      const fileName = `selfie-${Date.now()}.jpg`;

      // Upload and start processing
      const updated = await driverService.uploadSelfieCheck(
        activeCheck.id,
        asset.uri,
        fileName,
      );
      setCheck(updated);
    } catch (err) {
      console.error('Selfie check error:', err);
    } finally {
      setLoading(false);
    }
  }, [driverProfileId, check]);

  // Poll for result when processing
  useEffect(() => {
    if (!check || check.status !== 'processing' || !driverProfileId) return;

    const interval = setInterval(async () => {
      try {
        const latest = await driverService.getLatestSelfieCheck(driverProfileId);
        if (latest && latest.status !== 'processing') {
          setCheck(latest);
          clearInterval(interval);
        }
      } catch {
        // retry
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [check?.status, driverProfileId]);

  return {
    check,
    needsCheck,
    isProcessing,
    loading,
    submitSelfie,
  };
}
