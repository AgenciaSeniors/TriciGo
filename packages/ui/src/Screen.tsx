import React from 'react';
import {
  View,
  StatusBar,
  ScrollView,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export interface ScreenProps extends ViewProps {
  /** Use scroll view for scrollable content */
  scroll?: boolean;
  /** Status bar style */
  statusBarStyle?: 'light-content' | 'dark-content';
  /** Background color variant.
   *
   * - `white`: legacy default. Pure white in light, neutral-900 in dark.
   * - `neutral`: subtle gray base. neutral-50 light / neutral-950 dark.
   * - `cuban`: Cuban Modern paper — warm cream (#FFFBF5) in light,
   *   deep navy (#0A0E1A) in dark. Use for any client app screen
   *   that should match the home aesthetic (passenger sub-pages,
   *   profile, wallet, rides). Identical contrast to `white` but
   *   with the warmer brand-aligned palette.
   * - `dark` / `mapDark` / `lightPrimary`: legacy fixed palettes.
   */
  bg?: 'white' | 'neutral' | 'dark' | 'mapDark' | 'lightPrimary' | 'cuban';
  /** Add horizontal padding */
  padded?: boolean;
  /** Optional RefreshControl for pull-to-refresh (requires scroll=true) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refreshControl?: React.ReactElement<any>;
}

const bgClasses = {
  white: 'bg-white dark:bg-neutral-900',
  neutral: 'bg-neutral-50 dark:bg-neutral-950',
  dark: 'bg-[#0d0d1a]',
  mapDark: 'bg-[#0a0a0f]',
  lightPrimary: 'bg-[#F8FAFC]',
  cuban: 'bg-cuban-paper dark:bg-cuban-dark-paper',
} as const;

export function Screen({
  scroll = false,
  statusBarStyle = 'dark-content',
  bg = 'white',
  padded = true,
  refreshControl,
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
        barStyle={bg === 'dark' || bg === 'mapDark' ? 'light-content' : statusBarStyle}
        backgroundColor={bg === 'dark' ? '#111111' : bg === 'mapDark' ? '#0a0a0f' : undefined}
      />
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}
