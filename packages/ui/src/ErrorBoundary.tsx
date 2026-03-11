import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';

export interface ErrorBoundaryProps {
  /** Custom fallback UI to render when an error occurs */
  fallback?: ReactNode;
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
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <View className="flex-1 justify-center items-center bg-white p-6">
          <View className="w-20 h-20 rounded-full bg-primary-50 items-center justify-center mb-4">
            <Ionicons name="warning-outline" size={40} color={colors.brand.orange} />
          </View>
          <Text className="text-lg font-semibold text-neutral-900 mt-2">
            Algo salió mal
          </Text>
          <Text className="text-sm text-neutral-500 mt-2 text-center">
            Ha ocurrido un error inesperado. Intenta de nuevo.
          </Text>
          <Pressable
            className="mt-6 px-6 py-3 bg-neutral-900 rounded-lg active:bg-neutral-800"
            onPress={this.handleRetry}
          >
            <Text className="text-white text-base font-semibold">
              Reintentar
            </Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}
