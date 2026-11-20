import React, { useEffect, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, View, type ViewProps } from 'react-native';
import { keyboardInset } from '@/lib/keyboardInset';

/** On Android, the height the keyboard covers above the navigation bar. */
function useAndroidKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setInset(keyboardInset(e)));
    const hide = Keyboard.addListener('keyboardDidHide', () => setInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return inset;
}

/**
 * A full-height container that keeps its content above the keyboard, for a
 * screen inside `Screen` (whose safe area ends on the navigation bar).
 *
 * iOS uses KeyboardAvoidingView, which works there. On Android with
 * edge-to-edge it does not: with 'height' the ride chat kept its input and
 * Send under the keyboard, so Android pads by the keyboard height instead
 * (QA R2-07, see lib/keyboardInset.ts).
 */
export function KeyboardAwareView({ children, style, ...props }: ViewProps) {
  const inset = useAndroidKeyboardInset();
  if (Platform.OS === 'ios') {
    return (
      <KeyboardAvoidingView behavior="padding" style={[{ flex: 1 }, style]} {...props}>
        {children}
      </KeyboardAvoidingView>
    );
  }
  return (
    <View style={[{ flex: 1, paddingBottom: inset }, style]} {...props}>
      {children}
    </View>
  );
}
