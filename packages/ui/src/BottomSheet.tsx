import React from 'react';
import { View, Pressable, Modal, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface BottomSheetProps {
  visible: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  className?: string;
}

export function BottomSheet({
  visible,
  onClose,
  children,
  className,
}: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* KeyboardAvoidingView lifts the sheet above the keyboard so inputs
          and bottom action buttons stay reachable (critical on iOS — Android
          relies on adjustResize, and callers also dismiss the keyboard before
          showing an action step). */}
      <KeyboardAvoidingView
        style={{ flex: 1, justifyContent: 'flex-end' }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Backdrop */}
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
        />

        {/* Content — capped at 88% height so a tall sheet (search results,
            long forms) never exceeds the viewport, and padded for the bottom
            safe area / gesture bar so the last button isn't on the edge. */}
        <View
          className={`bg-white dark:bg-neutral-900 rounded-t-2xl px-5 pt-4 ${className ?? ''}`}
          style={{ maxHeight: '88%', paddingBottom: Math.max(insets.bottom, 16) + 12 }}
        >
          {/* Handle bar */}
          <View className="w-10 h-1 rounded-full bg-neutral-300 dark:bg-neutral-700 self-center mb-4" />
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
