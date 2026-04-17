import { useWindowDimensions } from 'react-native';

/**
 * Responsive layout hook for React Native.
 * Detects device category based on screen width:
 * - Phone: < 600px (standard phones)
 * - Foldable inner: 600-750px (Galaxy Z Fold inner screen ~717px)
 * - Tablet: >= 600px (iPads, Android tablets)
 * - Large tablet: >= 900px (iPad Pro, large Android tablets)
 */
export function useResponsive() {
  const { width, height } = useWindowDimensions();

  return {
    /** Standard phone (< 600px width) */
    isPhone: width < 600,
    /** Tablet or foldable inner screen (>= 600px) */
    isTablet: width >= 600,
    /** Galaxy Z Fold inner screen range (~600-750px) */
    isFoldable: width >= 600 && width < 750,
    /** Large tablet like iPad Pro (>= 900px) */
    isLargeTablet: width >= 900,
    /** Device is in landscape orientation */
    isLandscape: width > height,
    /** Current screen width in pixels */
    screenWidth: width,
    /** Current screen height in pixels */
    screenHeight: height,
    /** Desktop breakpoint (>= 1024px) */
    isDesktop: width >= 1024,
    /** Wide/ultrawide breakpoint (>= 1440px) */
    isWide: width >= 1440,
  };
}
