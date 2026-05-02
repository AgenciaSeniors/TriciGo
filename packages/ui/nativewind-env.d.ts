/// <reference types="nativewind/types" />

// NOTE: Mirrors apps/client/nativewind-env.d.ts + apps/driver/nativewind-env.d.ts
// so packages/ui components that use `className` on React Native
// primitives (View, Pressable, Text, Animated.*) type-check both when
// compiled standalone (pnpm --filter @tricigo/ui exec tsc) and when
// consumed from an app that runs tsc across the workspace.

// Module augmentation for the local react-native copy in packages/ui/node_modules.
// react-native-css-interop/types augments the root node_modules copy, but when
// packages/ui files import "react-native" they resolve to the local copy.
// Adding export {} makes this a module so declare module becomes an augmentation.
export {};
declare module "react-native" {
  interface ViewProps {
    className?: string;
    cssInterop?: boolean;
  }
  interface TextProps {
    className?: string;
    cssInterop?: boolean;
  }
  interface TextInputProps {
    className?: string;
    placeholderClassName?: string;
  }
  interface ImagePropsBase {
    className?: string;
    cssInterop?: boolean;
  }
  interface TouchableWithoutFeedbackProps {
    className?: string;
    cssInterop?: boolean;
  }
  interface PressableProps {
    className?: string;
  }
}
