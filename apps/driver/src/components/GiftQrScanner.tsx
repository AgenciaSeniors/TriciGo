import React, { useEffect, useRef } from 'react';
import { Modal, View, Pressable, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

/**
 * Extract the gift code from a scanned QR payload. The QR encodes
 * `tricigo-driver://gift/<code>` (or `tricigo://gift/<code>`); also
 * tolerate a raw code so a plain-text QR still works.
 */
function extractGiftCode(data: string): string {
  const m = data.match(/gift\/([A-Za-z0-9]{4,32})/i);
  return (m?.[1] ?? data).trim();
}

interface GiftQrScannerProps {
  visible: boolean;
  onClose: () => void;
  onScanned: (code: string) => void;
}

/**
 * Full-screen QR scanner for the gift flow. Reads a friend's gift QR
 * (their referral code) and hands the code back to the caller, which
 * resolves it to a recipient. Native only — hidden on web.
 */
export function GiftQrScanner({ visible, onClose, onScanned }: GiftQrScannerProps) {
  const { t } = useTranslation('common');
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      scannedRef.current = false;
      if (permission && !permission.granted && permission.canAskAgain) {
        void requestPermission();
      }
    }
  }, [visible, permission, requestPermission]);

  if (Platform.OS === 'web') return null;

  const handleScanned = ({ data }: { data: string }) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    onScanned(extractGiftCode(data));
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleScanned}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.permWrap]}>
            <Ionicons name="camera-outline" size={48} color="#fff" />
            <Text variant="body" style={styles.permText}>
              {t('gift.camera_permission', { defaultValue: 'Necesitamos la cámara para escanear el código QR.' })}
            </Text>
            <Button
              title={t('gift.grant_camera', { defaultValue: 'Permitir cámara' })}
              variant="primary"
              size="md"
              onPress={() => { void requestPermission(); }}
            />
          </View>
        )}

        <View style={styles.overlay} pointerEvents="box-none">
          <Pressable
            onPress={onClose}
            style={[styles.close, { top: insets.top + 12 }]}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('gift.close_scanner', { defaultValue: 'Cerrar' })}
          >
            <Ionicons name="close" size={28} color="#fff" />
          </Pressable>
          {permission?.granted ? <View style={styles.frame} /> : null}
          {permission?.granted ? (
            <Text variant="bodySmall" style={styles.hint}>
              {t('gift.scan_hint', { defaultValue: 'Apunta al código QR del amigo' })}
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  permWrap: { backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', padding: 32 },
  permText: { color: '#fff', textAlign: 'center', marginVertical: 16 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  close: {
    position: 'absolute',
    top: 48,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { width: 240, height: 240, borderWidth: 3, borderColor: '#FF4D00', borderRadius: 24, backgroundColor: 'transparent' },
  hint: {
    color: '#fff',
    marginTop: 24,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
});
