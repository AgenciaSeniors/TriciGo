import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  Modal,
  View,
  PanResponder,
  Animated,
  Dimensions,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImageManipulator from 'expo-image-manipulator';
import { Text } from './Text';
import { colors } from '@tricigo/theme';
import { triggerHaptic } from '@tricigo/utils';

const { width: SCREEN_W } = Dimensions.get('window');
const FRAME_SIZE = Math.min(SCREEN_W - 48, 320);
const FRAME_RADIUS = FRAME_SIZE / 2;

// Output target tuned for Cuban bandwidth: 384×384 JPEG q=0.7 → ~25–40 KB.
const OUTPUT_SIZE = 384;
const OUTPUT_QUALITY = 0.7;

interface AvatarCropModalProps {
  visible: boolean;
  imageUri: string | null;
  imageWidth: number;
  imageHeight: number;
  onCancel: () => void;
  onConfirm: (croppedUri: string) => void | Promise<void>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function AvatarCropModal({
  visible,
  imageUri,
  imageWidth,
  imageHeight,
  onCancel,
  onConfirm,
}: AvatarCropModalProps) {
  const [processing, setProcessing] = useState(false);

  // Compute display geometry — image's shorter side fills the frame, longer
  // side overflows. User pans along the longer axis to choose the crop.
  const layout = useMemo(() => {
    if (!imageWidth || !imageHeight) {
      return { displayWidth: FRAME_SIZE, displayHeight: FRAME_SIZE, scale: 1 };
    }
    const aspectRatio = imageWidth / imageHeight;
    let displayWidth: number;
    let displayHeight: number;
    if (aspectRatio >= 1) {
      displayHeight = FRAME_SIZE;
      displayWidth = FRAME_SIZE * aspectRatio;
    } else {
      displayWidth = FRAME_SIZE;
      displayHeight = FRAME_SIZE / aspectRatio;
    }
    const scale = imageWidth / displayWidth;
    return { displayWidth, displayHeight, scale };
  }, [imageWidth, imageHeight]);

  const maxOffsetX = Math.max(0, (layout.displayWidth - FRAME_SIZE) / 2);
  const maxOffsetY = Math.max(0, (layout.displayHeight - FRAME_SIZE) / 2);

  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const lastOffset = useRef({ x: 0, y: 0 });

  // Reset pan whenever a new image comes in.
  useEffect(() => {
    if (visible && imageUri) {
      pan.setValue({ x: 0, y: 0 });
      lastOffset.current = { x: 0, y: 0 };
    }
  }, [visible, imageUri, pan]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_, gesture) => {
          const x = clamp(lastOffset.current.x + gesture.dx, -maxOffsetX, maxOffsetX);
          const y = clamp(lastOffset.current.y + gesture.dy, -maxOffsetY, maxOffsetY);
          pan.setValue({ x, y });
        },
        onPanResponderRelease: (_, gesture) => {
          lastOffset.current = {
            x: clamp(lastOffset.current.x + gesture.dx, -maxOffsetX, maxOffsetX),
            y: clamp(lastOffset.current.y + gesture.dy, -maxOffsetY, maxOffsetY),
          };
        },
      }),
    [maxOffsetX, maxOffsetY, pan],
  );

  const handleConfirm = async () => {
    if (!imageUri || processing) return;
    setProcessing(true);
    try {
      // Frame center in display space, after the user dragged by lastOffset.
      const frameCenterDispX = layout.displayWidth / 2 - lastOffset.current.x;
      const frameCenterDispY = layout.displayHeight / 2 - lastOffset.current.y;
      const halfFrameDisp = FRAME_SIZE / 2;
      const cropDispOriginX = frameCenterDispX - halfFrameDisp;
      const cropDispOriginY = frameCenterDispY - halfFrameDisp;

      // Convert to original-image pixels.
      const cropImagePx = FRAME_SIZE * layout.scale;
      const originX = cropDispOriginX * layout.scale;
      const originY = cropDispOriginY * layout.scale;

      // Clamp to image bounds (paranoid — drag clamping should already keep us inside).
      const safeOriginX = clamp(originX, 0, Math.max(0, imageWidth - cropImagePx));
      const safeOriginY = clamp(originY, 0, Math.max(0, imageHeight - cropImagePx));
      const safeSize = Math.min(cropImagePx, imageWidth - safeOriginX, imageHeight - safeOriginY);

      const result = await ImageManipulator.manipulateAsync(
        imageUri,
        [
          { crop: { originX: safeOriginX, originY: safeOriginY, width: safeSize, height: safeSize } },
          { resize: { width: OUTPUT_SIZE, height: OUTPUT_SIZE } },
        ],
        { compress: OUTPUT_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
      );

      triggerHaptic('success');
      await onConfirm(result.uri);
    } catch {
      triggerHaptic('warning');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!processing) onCancel();
      }}
      statusBarTranslucent
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.96)',
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 16,
        }}
      >
        {/* Top bar */}
        <View
          style={{
            position: 'absolute',
            top: Platform.OS === 'ios' ? 56 : 24,
            left: 16,
            right: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Pressable
            onPress={() => {
              if (!processing) onCancel();
            }}
            disabled={processing}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Cancelar"
          >
            <Ionicons name="close" size={28} color="#FFFFFF" />
          </Pressable>
          <Text variant="body" style={{ color: '#FFFFFF', fontWeight: '600' }}>
            Ajustar foto
          </Text>
          <Pressable
            onPress={handleConfirm}
            disabled={processing || !imageUri}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Listo"
          >
            {processing ? (
              <ActivityIndicator color={colors.brand.orange} />
            ) : (
              <Text
                variant="body"
                style={{ color: colors.brand.orange, fontWeight: '700' }}
              >
                Listo
              </Text>
            )}
          </Pressable>
        </View>

        {/* Crop area */}
        <View
          style={{
            width: FRAME_SIZE,
            height: FRAME_SIZE,
            position: 'relative',
            overflow: 'hidden',
          }}
          {...panResponder.panHandlers}
        >
          {imageUri ? (
            <Animated.Image
              source={{ uri: imageUri }}
              style={{
                width: layout.displayWidth,
                height: layout.displayHeight,
                position: 'absolute',
                left: (FRAME_SIZE - layout.displayWidth) / 2,
                top: (FRAME_SIZE - layout.displayHeight) / 2,
                transform: [{ translateX: pan.x }, { translateY: pan.y }],
              }}
              resizeMode="cover"
            />
          ) : null}

          {/* Circular frame outline (non-interactive) */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: FRAME_SIZE,
              height: FRAME_SIZE,
              borderRadius: FRAME_RADIUS,
              borderWidth: 3,
              borderColor: 'rgba(255,255,255,0.95)',
            }}
          />
        </View>

        {/* Hint */}
        <Text
          variant="bodySmall"
          style={{
            color: 'rgba(255,255,255,0.75)',
            marginTop: 24,
            textAlign: 'center',
            paddingHorizontal: 24,
          }}
        >
          Arrastra la imagen para centrar tu cara en el círculo
        </Text>
      </View>
    </Modal>
  );
}
