import React from 'react';
import { View, Pressable, Modal } from 'react-native';

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
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end">
        {/* Backdrop */}
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
        />

        {/* Content */}
        <View
          className={`bg-white rounded-t-2xl px-5 pt-4 pb-8 ${className ?? ''}`}
        >
          {/* Handle bar */}
          <View className="w-10 h-1 rounded-full bg-neutral-300 self-center mb-4" />
          {children}
        </View>
      </View>
    </Modal>
  );
}
