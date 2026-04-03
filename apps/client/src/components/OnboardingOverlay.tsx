import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Modal,
  Pressable,
  Animated,
  Dimensions,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { colors, darkColors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';

interface OnboardingOverlayProps {
  onComplete: () => void;
}

interface OnboardingStep {
  icon: keyof typeof Ionicons.glyphMap;
  titleKey: string;
  descKey: string;
  iconColor: string;
  iconBg: string;
}

function buildSteps(isDark: boolean): OnboardingStep[] {
  return [
    {
      icon: 'rocket-outline',
      titleKey: 'onboarding.slide1_title',
      descKey: 'onboarding.slide1_desc',
      iconColor: colors.brand.orange,
      iconBg: colors.primary[50],
    },
    {
      icon: 'car-sport',
      titleKey: 'onboarding.slide2_title',
      descKey: 'onboarding.slide2_desc',
      iconColor: isDark ? '#60A5FA' : '#2563eb',
      iconBg: isDark ? darkColors.background.tertiary : '#eff6ff',
    },
    {
      icon: 'shield-checkmark',
      titleKey: 'onboarding.slide3_title',
      descKey: 'onboarding.slide3_desc',
      iconColor: isDark ? '#4ADE80' : '#16a34a',
      iconBg: isDark ? darkColors.background.tertiary : '#f0fdf4',
    },
    {
      icon: 'wallet',
      titleKey: 'onboarding.slide4_title',
      descKey: 'onboarding.slide4_desc',
      iconColor: isDark ? '#A78BFA' : '#7c3aed',
      iconBg: isDark ? darkColors.background.tertiary : '#f5f3ff',
    },
  ];
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export function OnboardingOverlay({ onComplete }: OnboardingOverlayProps) {
  const { t } = useTranslation('rider');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const STEPS = useMemo(() => buildSteps(isDark), [isDark]);
  const [currentStep, setCurrentStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  const animateTransition = useCallback(
    (nextStep: number) => {
      // Fade out current step
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start(() => {
        setCurrentStep(nextStep);
        // Slide in new step from right
        slideAnim.setValue(300);
        Animated.parallel([
          Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.spring(slideAnim, { toValue: 0, friction: 8, useNativeDriver: true }),
        ]).start();
      });
    },
    [fadeAnim, slideAnim],
  );

  const handleNext = useCallback(() => {
    if (currentStep < STEPS.length - 1) {
      animateTransition(currentStep + 1);
    } else {
      onComplete();
    }
  }, [currentStep, animateTransition, onComplete]);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  const step = STEPS[currentStep];
  const isLastStep = currentStep === STEPS.length - 1;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: isDark ? darkColors.background.secondary : '#ffffff' }]}>
          {/* Skip button */}
          {!isLastStep && (
            <Pressable
              style={styles.skipButton}
              onPress={handleSkip}
              accessibilityRole="button"
              accessibilityLabel={t('onboarding.skip')}
            >
              <Text style={[styles.skipText, { color: isDark ? darkColors.text.tertiary : '#9ca3af' }]}>{t('onboarding.skip', { defaultValue: 'Omitir' })}</Text>
            </Pressable>
          )}

          <Animated.View style={[styles.content, { opacity: fadeAnim, transform: [{ translateX: slideAnim }] }]}>
            {/* Icon */}
            <View
              style={[
                styles.iconCircle,
                { backgroundColor: step.iconBg },
              ]}
            >
              <Ionicons name={step.icon} size={48} color={step.iconColor} />
            </View>

            {/* Title */}
            <Text style={[styles.title, { color: isDark ? darkColors.text.primary : '#111111' }]}>{t(step.titleKey)}</Text>

            {/* Description */}
            <Text style={[styles.description, { color: isDark ? darkColors.text.secondary : '#555555' }]}>{t(step.descKey)}</Text>
          </Animated.View>

          {/* Dots indicator */}
          <View style={styles.dotsRow} accessibilityRole="tablist">
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  i === currentStep ? styles.dotActive : [styles.dotInactive, { backgroundColor: isDark ? darkColors.background.tertiary : '#d4d4d8' }],
                ]}
              />
            ))}
          </View>

          {/* Action button */}
          <Button
            title={isLastStep ? t('onboarding.start', { defaultValue: 'Comenzar' }) : t('onboarding.next', { defaultValue: 'Siguiente' })}
            onPress={handleNext}
            fullWidth
            accessibilityRole="button"
            accessibilityLabel={isLastStep ? t('onboarding.start') : t('onboarding.next')}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#ffffff', // overridden inline for dark mode
    borderRadius: 20,
    paddingHorizontal: 28,
    paddingTop: 40,
    paddingBottom: 28,
    alignItems: 'center',
  },
  skipButton: {
    position: 'absolute',
    top: 16,
    right: 20,
    padding: 4,
  },
  skipText: {
    fontSize: 14,
    color: '#9ca3af',
    fontWeight: '500',
  },
  content: {
    alignItems: 'center',
    width: '100%',
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111111',
    textAlign: 'center',
    marginBottom: 12,
  },
  description: {
    fontSize: 15,
    color: '#555555',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
    paddingHorizontal: 8,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotActive: {
    backgroundColor: colors.brand.orange,
    width: 24,
  },
  dotInactive: {
    backgroundColor: '#d4d4d8',
  },
});
