import React from 'react';
import { View } from 'react-native';
import { Text } from './Text';

export interface StatusStep {
  key: string;
  label: string;
}

export interface StatusStepperProps {
  steps: StatusStep[];
  currentStep: string;
  variant?: 'light' | 'dark';
  className?: string;
}

export function StatusStepper({
  steps,
  currentStep,
  variant = 'light',
  className,
}: StatusStepperProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentStep);

  const isDark = variant === 'dark';
  const completedBg = 'bg-primary-500';
  const currentBg = 'bg-primary-500';
  const pendingBg = isDark ? 'bg-neutral-700' : 'bg-neutral-200';
  const completedLine = 'bg-primary-500';
  const pendingLine = isDark ? 'bg-neutral-700' : 'bg-neutral-200';
  const textColor = isDark ? 'inverse' : 'secondary';
  const activeTextColor = isDark ? 'inverse' : 'accent';

  return (
    <View className={`flex-row items-center ${className ?? ''}`}>
      {steps.map((step, i) => {
        const isCompleted = i < currentIndex;
        const isCurrent = i === currentIndex;

        return (
          <View key={step.key} className="flex-1 items-center">
            {/* Line + Circle row */}
            <View className="flex-row items-center w-full">
              {/* Left line */}
              {i > 0 && (
                <View
                  className={`flex-1 h-0.5 ${
                    isCompleted || isCurrent ? completedLine : pendingLine
                  }`}
                />
              )}
              {i === 0 && <View className="flex-1" />}

              {/* Circle */}
              <View
                className={`w-4 h-4 rounded-full ${
                  isCompleted
                    ? completedBg
                    : isCurrent
                      ? currentBg
                      : pendingBg
                } ${isCurrent ? 'border-2 border-primary-300' : ''}`}
              />

              {/* Right line */}
              {i < steps.length - 1 && (
                <View
                  className={`flex-1 h-0.5 ${
                    isCompleted ? completedLine : pendingLine
                  }`}
                />
              )}
              {i === steps.length - 1 && <View className="flex-1" />}
            </View>

            {/* Label */}
            <Text
              variant="caption"
              color={isCurrent ? activeTextColor : textColor}
              className="mt-1 text-center"
              numberOfLines={1}
            >
              {step.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
