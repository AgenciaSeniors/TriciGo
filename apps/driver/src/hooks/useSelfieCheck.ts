import { useEffect, useState, useCallback, useRef } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { driverService } from '@tricigo/api';
import type { SelfieCheck } from '@tricigo/types';
import { useDriverStore } from '@/stores/driver.store';
import { compressDocument } from '@/lib/compressDocument';
import {
  markPickerLaunch,
  clearPickerMarker,
  consumeRecoveredPickerAsset,
} from '@/lib/cameraRecovery';

const RECOVERY_FLOW = 'selfie-check';

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

  // Shared tail of the flow (compress + upload), used by the normal camera
  // path AND by the recovery path after Android killed the app mid-capture.
  const processSelfieAsset = useCallback(async (assetUri: string) => {
    if (!driverProfileId) return;
    setLoading(true);
    try {
      // Ensure there's a pending check (in the recovery path the pre-camera
      // request may have happened in the killed process; re-resolving is safe).
      let activeCheck = check;
      if (!activeCheck || activeCheck.status !== 'pending') {
        activeCheck = await driverService.requestSelfieCheck(driverProfileId);
        setCheck(activeCheck);
      }

      const fileName = `selfie-${Date.now()}.jpg`;

      // PASS #3 UPLOAD-SELFIE: compress before upload. A raw front-camera selfie
      // is 2–5 MB and times out on a Cuban 3G link, blocking the driver from
      // going online for their shift. 1600px / q0.7 JPEG → ~150–400 KB.
      // Best-effort: compressDocument falls back to the original on failure.
      const { uri: uploadUri } = await compressDocument(assetUri, 'image/jpeg');

      // Upload and start processing
      const updated = await driverService.uploadSelfieCheck(
        activeCheck.id,
        driverProfileId,
        uploadUri,
        fileName,
      );
      setCheck(updated);
    } catch (err) {
      console.warn('[SelfieCheck] Error:', err instanceof Error ? err.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [driverProfileId, check]);

  const submitSelfie = useCallback(async () => {
    if (!driverProfileId) return;

    setLoading(true);
    try {
      // Open camera. Mark the launch first: on low-RAM Android the OS may kill
      // our process while the camera is foregrounded; the marker lets the
      // relaunched app recover the captured photo (see cameraRecovery.ts).
      await markPickerLaunch(RECOVERY_FLOW);
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        quality: 0.8,
        allowsEditing: false,
        cameraType: ImagePicker.CameraType.front,
      });
      await clearPickerMarker(); // returned alive — no recovery needed

      if (result.canceled || !result.assets?.[0]) {
        setLoading(false);
        return;
      }

      await processSelfieAsset(result.assets[0].uri);
    } catch (err) {
      console.warn('[SelfieCheck] Error:', err instanceof Error ? err.message : 'unknown');
    } finally {
      setLoading(false);
    }
  }, [driverProfileId, processSelfieAsset]);

  // Recovery: if Android killed the app while the selfie camera was open, pick
  // up the captured photo on relaunch and resume the upload automatically.
  // consumeRecoveredPickerAsset is one-shot, so re-runs of this effect are no-ops.
  useEffect(() => {
    if (!driverProfileId) return;
    let cancelled = false;
    consumeRecoveredPickerAsset(RECOVERY_FLOW).then((rec) => {
      if (!cancelled && rec) void processSelfieAsset(rec.asset.uri);
    });
    return () => { cancelled = true; };
  }, [driverProfileId, processSelfieAsset]);

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
