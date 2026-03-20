import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';

export interface ErrorBoundaryLabels {
  title: string;
  message: string;
  retry: string;
}

export interface ErrorBoundaryProps {
  /** Custom fallback UI to render when an error occurs */
  fallback?: ReactNode;
  /** Called when an error is caught — use for crash reporting (e.g. Sentry) */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Localized labels for the default error screen */
  labels?: ErrorBoundaryLabels;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const labels = this.props.labels ?? {
        title: 'Algo salió mal',
        message: 'Ha ocurrido un error inesperado. Intenta de nuevo.',
        retry: 'Reintentar',
      };

      return (
        <View className="flex-1 justify-center items-center bg-white p-6">
          <View accessibilityElementsHidden className="w-20 h-20 rounded-full bg-primary-50 items-center justify-center mb-4">
            <Ionicons name="warning-outline" size={40} color={colors.brand.orange} />
          </View>
          <Text className="text-lg font-semibold text-neutral-900 mt-2">
            {labels.title}
          </Text>
          <Text className="text-sm text-neutral-500 mt-2 text-center">
            {labels.message}
          </Text>
          <Pressable
            className="mt-6 px-6 py-3 bg-neutral-900 rounded-lg active:bg-neutral-800"
            onPress={this.handleRetry}
            accessibilityRole="button"
            accessibilityLabel={labels.retry}
          >
            <Text className="text-white text-base font-semibold">
              {labels.retry}
            </Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}
