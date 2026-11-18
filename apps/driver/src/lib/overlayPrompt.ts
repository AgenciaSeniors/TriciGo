// ============================================================
// TriciGo Driver — ask for the permissions that let the app open by
// itself when a ride offer arrives (Android)
// ============================================================
// Step 1: "Display over other apps". Until 2026-11 the app asked once and
// "Ahora no" was forever; now it asks again, at most every 3 days, when the
// driver goes online. Step 2, only on Xiaomi, Redmi and POCO: their own
// "Display pop-up windows while running in the background" permission, which
// Android cannot read. It shows right after step 1 is granted (on the return
// from the system screen), otherwise when going online with its own 3-day
// cooldown, until the driver taps "Ya lo activé" or a launch is seen to reach
// the front (lib/offerLaunch.ts).
// The rules: nextOverlayStep in @tricigo/utils. Spec:
// docs/superpowers/specs/2026-11-18-driver-offer-autoopen-reach-design.md
import { Alert, AppState, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import i18next from 'i18next';
import { isXiaomiFamily, logger, nextOverlayStep, type OverlayStep } from '@tricigo/utils';
import DriverOverlay, { isDriverOverlayAvailable } from '../../modules/driver-overlay';
import { getDeviceMaker } from '@/lib/device';
import { reportOverlayStatus, XIAOMI_OK_KEY } from '@/lib/overlayReport';

const OVERLAY_PROMPT_AT_KEY = (userId: string): string => `@tricigo/overlay_prompt_at:${userId}`;
const XIAOMI_PROMPT_AT_KEY = (userId: string): string => `@tricigo/xiaomi_prompt_at:${userId}`;
const DRIVER_PACKAGE = 'app.tricigo.driver';

function tr(key: string, defaultValue: string): string {
  return i18next.t(`driver:overlay.${key}`, { defaultValue });
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Xiaomi, Redmi or POCO phone. */
export function isXiaomiPhone(): boolean {
  const maker = getDeviceMaker();
  return isXiaomiFamily(maker.manufacturer, maker.brand);
}

/**
 * Open MIUI's permission editor for this app; if this ROM does not have it,
 * the app's system page. Never throws.
 */
export async function openXiaomiPermissions(): Promise<void> {
  try {
    await Linking.sendIntent('miui.intent.action.APP_PERM_EDITOR', [
      { key: 'extra_pkgname', value: DRIVER_PACKAGE },
    ]);
  } catch {
    try {
      await Linking.openSettings();
    } catch (err) {
      logger.warn('[OverlayPrompt] could not open the permission screen', { error: String(err) });
    }
  }
}

async function markXiaomiDone(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(XIAOMI_OK_KEY(userId), 'true');
  } catch {
    /* the step comes back in 3 days */
  }
  await reportOverlayStatus(userId);
}

async function showXiaomiAlert(userId: string): Promise<void> {
  await AsyncStorage.setItem(XIAOMI_PROMPT_AT_KEY(userId), String(Date.now()));
  Alert.alert(
    tr('xiaomi_title', 'Un permiso más en tu Xiaomi'),
    tr(
      'xiaomi_body',
      'Para que TriciGo se abra sola, activa también «Mostrar ventanas emergentes mientras se ejecuta en segundo plano». Toca Abrir permisos y búscalo en la lista; si se abre la información de la app, está en Otros permisos.',
    ),
    [
      { text: tr('prompt_later', 'Ahora no'), style: 'cancel' },
      { text: tr('xiaomi_done', 'Ya lo activé'), onPress: () => void markXiaomiDone(userId) },
      { text: tr('xiaomi_open', 'Abrir permisos'), onPress: () => void openXiaomiPermissions() },
    ],
  );
}

/**
 * After "Activar", wait for the driver to come back from the system screen.
 * Report the new status, and on a Xiaomi phone with the permission now granted
 * and the step not done, show the Xiaomi alert at once. One return only.
 */
function armReturnFromSettings(userId: string): void {
  const sub = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    sub.remove();
    void (async () => {
      try {
        await reportOverlayStatus(userId);
        if (!DriverOverlay.canDrawOverlays() || !isXiaomiPhone()) return;
        if ((await AsyncStorage.getItem(XIAOMI_OK_KEY(userId))) === 'true') return;
        await showXiaomiAlert(userId);
      } catch (err) {
        logger.warn('[OverlayPrompt] follow-up failed', { error: String(err) });
      }
    })();
  });
}

async function showOverlayAlert(userId: string): Promise<void> {
  await AsyncStorage.setItem(OVERLAY_PROMPT_AT_KEY(userId), String(Date.now()));
  Alert.alert(
    tr('prompt_title', 'No te pierdas ningún viaje'),
    tr(
      'prompt_body',
      'Permite que TriciGo aparezca sobre otras apps: cuando llegue un viaje, la app se abrirá sola aunque estés usando otra aplicación, y verás un botón flotante para volver rápido.',
    ),
    [
      { text: tr('prompt_later', 'Ahora no'), style: 'cancel' },
      {
        text: tr('prompt_enable', 'Activar'),
        onPress: () => {
          armReturnFromSettings(userId);
          DriverOverlay.openOverlaySettings();
        },
      },
    ],
  );
}

/**
 * Called when the driver goes online. Shows the overlay alert or the Xiaomi
 * alert when one is due, and returns which one. Never blocks or throws: any
 * storage error means no alert this time.
 */
export async function maybePromptOverlay(userId: string): Promise<OverlayStep> {
  if (Platform.OS !== 'android') return 'none';
  try {
    const [overlayAt, xiaomiAt, xiaomiOk] = await Promise.all([
      AsyncStorage.getItem(OVERLAY_PROMPT_AT_KEY(userId)),
      AsyncStorage.getItem(XIAOMI_PROMPT_AT_KEY(userId)),
      AsyncStorage.getItem(XIAOMI_OK_KEY(userId)),
    ]);
    const step = nextOverlayStep({
      moduleAvailable: isDriverOverlayAvailable,
      overlayGranted: DriverOverlay.canDrawOverlays(),
      xiaomiFamily: isXiaomiPhone(),
      xiaomiOk: xiaomiOk === 'true',
      overlayPromptAt: parseTime(overlayAt),
      xiaomiPromptAt: parseTime(xiaomiAt),
      now: Date.now(),
    });
    if (step === 'overlay') await showOverlayAlert(userId);
    else if (step === 'xiaomi') await showXiaomiAlert(userId);
    return step;
  } catch (err) {
    logger.warn('[OverlayPrompt] prompt skipped', { error: String(err) });
    return 'none';
  }
}
