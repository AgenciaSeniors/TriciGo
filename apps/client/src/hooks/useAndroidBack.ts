import { useCallback, useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * Handles the Android back button while the calling screen is focused.
 * `onBack` returns true when it handled the press; false leaves it to React
 * Navigation (pop a pushed screen, go back to the first tab) or to Android
 * (send the app to the background).
 *
 * The home tab switches between steps (idle, selecting…) inside one screen,
 * so React Navigation has nothing to pop there and back used to close the
 * app from the service picker. Listening only while focused matters: tab
 * screens stay mounted, so a plain listener on the home tab would also catch
 * back presses meant for another tab or for a screen pushed on top.
 *
 * Does nothing on iOS, which has no back button.
 */
export function useAndroidBack(onBack: () => boolean): void {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => onBackRef.current());
      return () => subscription.remove();
    }, []),
  );
}
