import React, { useCallback, useMemo, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import BottomSheetLib, {
  BottomSheetScrollView,
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';

export interface DraggableSheetProps {
  /** Snap points as percentages or pixel values, e.g. ['25%', '50%', '90%'] */
  snapPoints: (string | number)[];
  /** Initial snap point index (default: 1 = middle) */
  initialIndex?: number;
  /** Sheet content */
  children: React.ReactNode;
  /** Visual theme */
  theme?: 'dark' | 'light';
  /** Allow swiping down to close */
  enablePanDownToClose?: boolean;
  /** Called when sheet is dismissed */
  onClose?: () => void;
  /** Enable scrollable content inside the sheet */
  scrollable?: boolean;
  /** Additional style for the sheet container */
  style?: object;
  /** Ref to control the sheet programmatically */
  sheetRef?: React.RefObject<BottomSheetLib | null>;
  /** Called when snap point changes */
  onChange?: (index: number) => void;
}

/**
 * Gesture-driven draggable bottom sheet with TriciGo theming.
 * Wraps @gorhom/bottom-sheet with consistent styling.
 */
export function DraggableSheet({
  snapPoints,
  initialIndex = 1,
  children,
  theme = 'dark',
  enablePanDownToClose = false,
  onClose,
  scrollable = false,
  style,
  sheetRef,
  onChange,
}: DraggableSheetProps) {
  const internalRef = useRef<BottomSheetLib>(null);
  const ref = sheetRef ?? internalRef;

  const isDark = theme === 'dark';

  const backgroundStyle = useMemo(
    () => ({
      backgroundColor: isDark ? '#141418' : '#FFFFFF',
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      ...(isDark
        ? { borderColor: 'rgba(255,255,255,0.08)', borderWidth: StyleSheet.hairlineWidth }
        : { shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 8 }),
    }),
    [isDark],
  );

  const handleIndicatorStyle = useMemo(
    () => ({
      backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : '#CBD5E1',
      width: 40,
      height: 4,
      borderRadius: 2,
    }),
    [isDark],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={isDark ? 0.3 : 0.15}
        pressBehavior={enablePanDownToClose ? 'close' : 'none'}
      />
    ),
    [isDark, enablePanDownToClose],
  );

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1 && onClose) onClose();
      if (onChange) onChange(index);
    },
    [onClose, onChange],
  );

  // Web fallback: render as a fixed bottom panel if needed
  if (Platform.OS === 'web') {
    return (
      <View
        style={[
          styles.webSheet,
          {
            backgroundColor: isDark ? '#141418' : '#FFFFFF',
            borderColor: isDark ? 'rgba(255,255,255,0.08)' : '#E2E8F0',
          },
          style,
        ]}
      >
        {/* Handle bar */}
        <View style={styles.webHandleContainer}>
          <View
            style={[
              styles.webHandle,
              { backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : '#CBD5E1' },
            ]}
          />
        </View>
        {children}
      </View>
    );
  }

  return (
    <BottomSheetLib
      ref={ref}
      snapPoints={snapPoints}
      index={initialIndex}
      backgroundStyle={backgroundStyle}
      handleIndicatorStyle={handleIndicatorStyle}
      backdropComponent={enablePanDownToClose ? renderBackdrop : undefined}
      enablePanDownToClose={enablePanDownToClose}
      onChange={handleSheetChange}
      style={style}
      animateOnMount
    >
      {scrollable ? (
        <BottomSheetScrollView contentContainerStyle={styles.scrollContent}>
          {children}
        </BottomSheetScrollView>
      ) : (
        <View style={styles.content}>{children}</View>
      )}
    </BottomSheetLib>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    paddingHorizontal: 20,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  webSheet: {
    position: 'absolute' as const,
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: '85%',
    overflow: 'hidden' as const,
    // Web-specific shadow
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 -4px 24px rgba(0,0,0,0.12)' }
      : {}),
  },
  webHandleContainer: {
    alignItems: 'center' as const,
    paddingTop: 12,
    paddingBottom: 8,
  },
  webHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
});
