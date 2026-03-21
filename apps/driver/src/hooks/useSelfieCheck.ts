import { useEffect, useState, useCallback, useRef } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { driverService } from '@tricigo/api';
import type { SelfieCheck } from '@tricigo/types';
import { useDriverStore } from '@/stores/driver.store';

export function useSelfieCheck() {
  const driverProfileId = useDriverStore((s) => s.profile?.id);
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

  // Polling is handled by the adaptive poller below (lines 93+)

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
        driverProfileId,
        asset.uri,
        fileName,
      );
      setCheck(updated);
    } catch (err) {
      console.warn('[SelfieCheck] Error:', err instanceof Error ? err.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [driverProfileId, check]);

  // Poll for result when processing (adaptive interval: 3s → 10s → 30s)
  const pollCountRef = useRef(0);
  useEffect(() => {
    if (!check || check.status !== 'processing' || !driverProfileId) return;
    pollCountRef.current = 0;

    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        const latest = await driverService.getLatestSelfieCheck(driverProfileId!);
        if (latest && latest.status !== 'processing') {
          setCheck(latest);
          return;
        }
      } catch {
        // retry on next poll
      }
      pollCountRef.current += 1;
      const delay = pollCountRef.current < 5 ? 3000 : pollCountRef.current < 15 ? 10000 : 30000;
      timeoutId = setTimeout(poll, delay);
    }

    timeoutId = setTimeout(poll, 3000);
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [check?.status, driverProfileId]);

  return {
    check,
    needsCheck,
    isProcessing,
    loading,
    submitSelfie,
  };
}
