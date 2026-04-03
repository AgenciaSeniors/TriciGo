import React, { useEffect, useRef, useCallback, useState, createContext, useContext } from 'react';
import { View, Animated, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastProps {
  message: string;
  variant?: ToastVariant;
  duration?: number;
  onDismiss?: () => void;
  visible: boolean;
}

const variantConfig = {
  success: { icon: 'checkmark-circle' as const, bg: '#065F46', border: '#22C55E', color: '#A7F3D0' },
  error: { icon: 'close-circle' as const, bg: '#7F1D1D', border: '#EF4444', color: '#FECACA' },
  info: { icon: 'information-circle' as const, bg: '#1E3A5F', border: '#3B82F6', color: '#BFDBFE' },
  warning: { icon: 'alert-circle' as const, bg: '#78350F', border: '#F59E0B', color: '#FDE68A' },
};

export function Toast({ message, variant = 'info', duration = 4000, onDismiss, visible }: ToastProps) {
  const translateY = useRef(new Animated.Value(-100)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  const v = variantConfig[variant];

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, damping: 20, stiffness: 200, mass: 1, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();

      if (duration > 0) {
        const timer = setTimeout(() => onDismiss?.(), duration);
        return () => clearTimeout(timer);
      }
    } else {
      Animated.parallel([
        Animated.timing(translateY, { toValue: -100, duration: 200, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, duration, onDismiss, translateY, opacity]);

  if (!visible) return null;

  return (
    <Animated.View
      style={{
        position: 'absolute',
        top: insets.top + 8,
        left: 16,
        right: 16,
        zIndex: 9999,
        transform: [{ translateY }],
        opacity,
      }}
    >
      <Pressable
        onPress={onDismiss}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: v.bg,
          borderWidth: 1,
          borderColor: v.border,
          borderRadius: 16,
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
        accessibilityRole="alert"
        accessibilityLabel={message}
      >
        <Ionicons name={v.icon} size={20} color={v.color} />
        <Text variant="bodySmall" style={{ color: v.color, flex: 1, marginLeft: 10 }}>
          {message}
        </Text>
        <Ionicons name="close" size={16} color={v.color} style={{ opacity: 0.6 }} />
      </Pressable>
    </Animated.View>
  );
}

// --- Toast Context (optional hook-based usage) ---

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
}

interface ToastContextValue {
  show: (message: string, variant?: ToastVariant, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, variant: ToastVariant = 'info', duration = 4000) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, variant, duration }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const current = toasts[0];

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {current && (
        <Toast
          key={current.id}
          message={current.message}
          variant={current.variant}
          duration={current.duration}
          visible
          onDismiss={() => dismiss(current.id)}
        />
      )}
    </ToastContext.Provider>
  );
}
