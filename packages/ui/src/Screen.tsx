import React from 'react';
import {
  SafeAreaView,
  View,
  StatusBar,
  ScrollView,
  type ViewProps,
} from 'react-native';

export interface ScreenProps extends ViewProps {
  /** Use scroll view for scrollable content */
  scroll?: boolean;
  /** Status bar style */
  statusBarStyle?: 'light-content' | 'dark-content';
  /** Background color variant */
  bg?: 'white' | 'neutral' | 'dark';
  /** Add horizontal padding */
  padded?: boolean;
}

const bgClasses = {
  white: 'bg-white dark:bg-neutral-900',
  neutral: 'bg-neutral-50 dark:bg-neutral-950',
  dark: 'bg-neutral-950',
} as const;

export function Screen({
  scroll = false,
  statusBarStyle = 'dark-content',
  bg = 'white',
  padded = true,
  className,
  children,
  ...props
}: ScreenProps & { className?: string }) {
  const content = (
    <View
      className={`flex-1 ${padded ? 'px-4' : ''} ${className ?? ''}`}
      {...props}
    >
      {children}
    </View>
  );

  return (
    <SafeAreaView className={`flex-1 ${bgClasses[bg]}`}>
      <StatusBar
        barStyle={bg === 'dark' ? 'light-content' : statusBarStyle}
        backgroundColor={bg === 'dark' ? '#111111' : undefined}
      />
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}
