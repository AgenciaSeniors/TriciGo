import React, { useState, useCallback } from 'react';
import { View, Image, ActivityIndicator } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { deliveryService } from '@tricigo/api';
import { triggerHaptic, logger } from '@tricigo/utils';
import { colors } from '@tricigo/theme';

interface DeliveryPhotoSheetProps {
  rideId: string;
  phase?: 'pickup' | 'delivery';
  onPhotoUploaded: () => void;
  onSkip?: () => void;
}

/**
 * Mandatory delivery photo capture sheet.
 * Supports two phases: 'pickup' (at package collection) and 'delivery' (at drop-off).
 */
export function DeliveryPhotoSheet({ rideId, phase = 'delivery', onPhotoUploaded, onSkip }: DeliveryPhotoSheetProps) {
  const { t } = useTranslation('driver');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const takePhoto = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Toast.show({
          type: 'error',
          text1: t('trip.camera_permission_denied', { defaultValue: 'Se necesita permiso de cámara' }),
        });
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        quality: 0.7,
        allowsEditing: false,
      });

      if (result.canceled || !result.assets?.[0]) return;

      setPhotoUri(result.assets[0].uri);
      triggerHaptic('light');
    } catch (err) {
      logger.error('[DeliveryPhoto] Camera error', { error: err instanceof Error ? err.message : 'unknown' });
      Toast.show({ type: 'error', text1: t('trip.camera_error', { defaultValue: 'Error al abrir cámara' }) });
    }
  }, [t]);

  const uploadAndConfirm = useCallback(async () => {
    if (!photoUri) return;

    setUploading(true);
    try {
      await deliveryService.uploadDeliveryPhoto(rideId, photoUri, phase);
      triggerHaptic('success');
      Toast.show({
        type: 'success',
        text1: phase === 'pickup'
          ? t('trip.pickup_photo_saved', { defaultValue: 'Foto de recogida guardada' })
          : t('trip.delivery_photo_saved', { defaultValue: 'Foto de entrega guardada' }),
      });
      onPhotoUploaded();
    } catch (err) {
      logger.error('[DeliveryPhoto] Upload error', { error: err instanceof Error ? err.message : 'unknown' });
      Toast.show({
        type: 'error',
        text1: t('trip.delivery_photo_upload_failed', { defaultValue: 'Error al subir foto. Intente de nuevo.' }),
      });
    } finally {
      setUploading(false);
    }
  }, [photoUri, rideId, onPhotoUploaded, t]);

  return (
    <Card variant="filled" padding="lg" className="bg-neutral-800 mb-4">
      <Text variant="h3" color="inverse" className="text-center mb-2">
        {phase === 'pickup'
          ? t('trip.pickup_photo_title', { defaultValue: 'Foto de recogida' })
          : t('trip.delivery_photo_title', { defaultValue: 'Foto de entrega' })}
      </Text>
      <Text variant="bodySmall" color="secondary" className="text-center mb-4">
        {phase === 'pickup'
          ? t('trip.pickup_photo_desc', { defaultValue: 'Tome una foto del paquete al recogerlo' })
          : t('trip.delivery_photo_desc', { defaultValue: 'Tome una foto del paquete entregado como comprobante' })}
      </Text>

      {photoUri ? (
        <View className="items-center mb-4">
          <Image
            source={{ uri: photoUri }}
            style={{ width: 240, height: 240, borderRadius: 12 }}
            resizeMode="cover"
          />
          <Button
            title={t('trip.retake_photo', { defaultValue: 'Tomar otra foto' })}
            variant="outline"
            size="sm"
            onPress={takePhoto}
            className="mt-2"
          />
        </View>
      ) : (
        <Button
          title={t('trip.take_delivery_photo', { defaultValue: 'Tomar foto' })}
          size="lg"
          fullWidth
          onPress={takePhoto}
          className="mb-2"
          icon="camera-outline"
        />
      )}

      {photoUri && (
        <Button
          title={
            uploading
              ? t('trip.uploading', { defaultValue: 'Subiendo...' })
              : phase === 'pickup'
                ? t('trip.confirm_pickup_photo', { defaultValue: 'Confirmar recogida' })
                : t('trip.confirm_delivery', { defaultValue: 'Confirmar entrega y completar' })
          }
          size="lg"
          fullWidth
          onPress={uploadAndConfirm}
          loading={uploading}
          disabled={uploading}
          style={{ backgroundColor: '#22C55E' }}
        />
      )}
    </Card>
  );
}
