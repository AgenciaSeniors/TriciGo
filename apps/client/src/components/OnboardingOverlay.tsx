import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Modal,
  Pressable,
  Animated,
  Dimensions,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { colors } from '@tricigo/theme';

interface OnboardingOverlayProps {
  onComplete: () => void;
}

interface OnboardingStep {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  iconColor: string;
  iconBg: string;
}

const STEPS: OnboardingStep[] = [
  {
    icon: 'car-sport',
    title: 'Solicita un viaje',
    description:
      'Escribe tu destino, elige el tipo de veh\u00edculo y confirma. Un conductor cercano te recoger\u00e1 en minutos.',
    iconColor: colors.brand.orange,
    iconBg: colors.primary[50],
  },
  {
    icon: 'wallet',
    title: 'Paga con TriciCoin',
    description:
      'Recarga tu billetera con TriciCoins y paga tus viajes de forma r\u00e1pida y segura desde la app.',
    iconColor: '#16a34a',
    iconBg: '#f0fdf4',
  },
  {
    icon: 'people',
    title: 'Invita amigos',
    description:
      'Comparte tu c\u00f3digo de referido y ambos recibir\u00e1n TriciCoins de bonificaci\u00f3n cuando completen su primer viaje.',
    iconColor: '#7c3aed',
    iconBg: '#f5f3ff',
  },
];

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export function OnboardingOverlay({ onComplete }: OnboardingOverlayProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const animateTransition = useCallback(
    (nextStep: number) => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start(() => {
        setCurrentStep(nextStep);
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }).start();
      });
    },
    [fadeAnim],
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
        <View style={styles.card}>
          {/* Skip button */}
          {!isLastStep && (
            <Pressable style={styles.skipButton} onPress={handleSkip}>
              <Text style={styles.skipText}>Omitir</Text>
            </Pressable>
          )}

          <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
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
            <Text style={styles.title}>{step.title}</Text>

            {/* Description */}
            <Text style={styles.description}>{step.description}</Text>
          </Animated.View>

          {/* Dots indicator */}
          <View style={styles.dotsRow}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  i === currentStep ? styles.dotActive : styles.dotInactive,
                ]}
              />
            ))}
          </View>

          {/* Action button */}
          <Button
            title={isLastStep ? 'Comenzar' : 'Siguiente'}
            onPress={handleNext}
            fullWidth
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
    backgroundColor: '#ffffff',
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
