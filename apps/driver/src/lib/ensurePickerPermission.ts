// ============================================================
// Image-picker permission gate (driver app)
//
// Request the OS permission for the chosen source BEFORE launching the picker.
// expo-image-picker's launchCameraAsync throws "Missing camera or camera roll
// permission" on iOS when camera permission wasn't requested/granted — the same
// class of bug Apple App Review flagged on the client (rejection 2.1(a)). The
// avatar / vehicle / document pickers used to launch with no prior request; the
// throw surfaced as a generic upload error.
//
// Returns true when the caller may proceed to launch the picker. When denied it
// shows a clear, source-specific message (and an "Open Settings" shortcut once
// the OS won't prompt again) instead of the misleading upload error.
// ============================================================
import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

export async function ensurePickerPermission(
  source: 'camera' | 'gallery',
  t: Translate,
): Promise<boolean> {
  const res =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

  // On iOS a "limited" photo selection still reports status 'granted'; the
  // system PHPicker then returns only the chosen asset, which is all we need.
  if (res.status === 'granted') return true;

  const body =
    source === 'camera'
      ? t('permissions.camera_body', {
          defaultValue: 'Activa el acceso a la cámara en Ajustes para tomar tu foto.',
        })
      : t('permissions.gallery_body', {
          defaultValue: 'Activa el acceso a tus fotos en Ajustes para elegir una imagen.',
        });

  Alert.alert(
    t('permissions.title', { defaultValue: 'Permiso necesario' }),
    body,
    res.canAskAgain
      ? [{ text: t('ok', { defaultValue: 'Entendido' }) }]
      : [
          { text: t('cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
          {
            text: t('permissions.open_settings', { defaultValue: 'Abrir Ajustes' }),
            onPress: () => {
              void Linking.openSettings();
            },
          },
        ],
  );
  return false;
}
