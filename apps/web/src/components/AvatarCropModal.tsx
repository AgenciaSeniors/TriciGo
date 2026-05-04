'use client';

/**
 * AvatarCropModal — web equivalent of mobile
 * `apps/client/src/components/AvatarCropModal.tsx`.
 *
 * Renders a fullscreen overlay with:
 *   - A 320×320 viewport showing the picked image
 *   - A circular guide overlay (the actual crop region)
 *   - Drag (mouse + touch) to reposition the image inside the viewport
 *   - A zoom slider (1.0 .. 3.0×)
 *   - Listo / Cancelar buttons in the top bar
 *
 * On confirm, draws the cropped square to a 384×384 canvas and produces
 * a JPEG blob at q=0.7 — identical output spec to mobile (~25-40 KB)
 * so the avatars bucket sees consistent file sizes regardless of the
 * upload source.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useTranslation } from '@tricigo/i18n';

const FRAME_SIZE = 320;
const FRAME_RADIUS = FRAME_SIZE / 2;
// Output spec mirrors mobile (apps/client/src/components/AvatarCropModal.tsx:23-24).
const OUTPUT_SIZE = 384;
const OUTPUT_QUALITY = 0.7;

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

export interface AvatarCropModalProps {
  /** Object URL of the picked image (e.g. `URL.createObjectURL(file)`). */
  imageUrl: string | null;
  visible: boolean;
  onCancel: () => void;
  /** Called with a JPEG Blob ready to upload to Supabase storage. */
  onConfirm: (blob: Blob) => void | Promise<void>;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function AvatarCropModal({ imageUrl, visible, onCancel, onConfirm }: AvatarCropModalProps) {
  const { t } = useTranslation('web');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [processing, setProcessing] = useState(false);

  // Layout: shorter side fills the frame, longer side overflows. The
  // user pans/zooms to choose the crop region. Zoom multiplies the
  // base displayed size.
  const layout = useMemo(() => {
    if (!imgDims) return { displayW: FRAME_SIZE, displayH: FRAME_SIZE };
    const ar = imgDims.w / imgDims.h;
    let baseW: number, baseH: number;
    if (ar >= 1) {
      baseH = FRAME_SIZE;
      baseW = FRAME_SIZE * ar;
    } else {
      baseW = FRAME_SIZE;
      baseH = FRAME_SIZE / ar;
    }
    return { displayW: baseW * zoom, displayH: baseH * zoom };
  }, [imgDims, zoom]);

  const maxOffsetX = Math.max(0, (layout.displayW - FRAME_SIZE) / 2);
  const maxOffsetY = Math.max(0, (layout.displayH - FRAME_SIZE) / 2);

  // Keep position inside bounds when zoom changes (zooming out from a
  // panned-to-edge position would otherwise leave a gap inside the frame).
  useEffect(() => {
    setPos((p) => ({ x: clamp(p.x, -maxOffsetX, maxOffsetX), y: clamp(p.y, -maxOffsetY, maxOffsetY) }));
  }, [maxOffsetX, maxOffsetY]);

  // Reset whenever a new image arrives.
  useEffect(() => {
    if (visible && imageUrl) {
      setZoom(1);
      setPos({ x: 0, y: 0 });
    }
  }, [visible, imageUrl]);

  // ── Drag (mouse + touch) ──
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; basePos: { x: number; y: number } }>({
    active: false, startX: 0, startY: 0, basePos: { x: 0, y: 0 },
  });

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (processing) return;
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      basePos: { ...pos },
    };
  }, [pos, processing]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPos({
      x: clamp(dragRef.current.basePos.x + dx, -maxOffsetX, maxOffsetX),
      y: clamp(dragRef.current.basePos.y + dy, -maxOffsetY, maxOffsetY),
    });
  }, [maxOffsetX, maxOffsetY]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current.active = false;
    try { (e.target as HTMLDivElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }, []);

  // ── Confirm: draw cropped + resized to 384×384 JPEG ──
  const handleConfirm = useCallback(async () => {
    if (!imgRef.current || !imgDims || processing) return;
    setProcessing(true);
    try {
      // Frame center in display space, after pan.
      const frameCenterDispX = layout.displayW / 2 - pos.x;
      const frameCenterDispY = layout.displayH / 2 - pos.y;
      const halfFrameDisp = FRAME_SIZE / 2;
      const cropDispOriginX = frameCenterDispX - halfFrameDisp;
      const cropDispOriginY = frameCenterDispY - halfFrameDisp;

      // Convert displayed-pixel space → original-image-pixel space.
      const scale = imgDims.w / layout.displayW;
      const cropImagePx = FRAME_SIZE * scale;
      const originX = clamp(cropDispOriginX * scale, 0, Math.max(0, imgDims.w - cropImagePx));
      const originY = clamp(cropDispOriginY * scale, 0, Math.max(0, imgDims.h - cropImagePx));
      const safeSize = Math.min(cropImagePx, imgDims.w - originX, imgDims.h - originY);

      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.drawImage(
        imgRef.current,
        originX, originY, safeSize, safeSize,    // source rect
        0, 0, OUTPUT_SIZE, OUTPUT_SIZE,           // destination rect
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', OUTPUT_QUALITY),
      );
      if (!blob) throw new Error('Failed to encode JPEG');
      await onConfirm(blob);
    } catch (err) {
      // Surface to the caller via console — the modal stays open so the
      // user can retry without re-picking.
      // eslint-disable-next-line no-console
      console.error('[AvatarCropModal] crop failed', err);
    } finally {
      setProcessing(false);
    }
  }, [imgDims, layout, pos, processing, onConfirm]);

  if (!visible || !imageUrl) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('profile.crop_title', { defaultValue: 'Ajustar foto' })}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.96)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      {/* Top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        padding: '1rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={processing}
          aria-label={t('common.cancel', { defaultValue: 'Cancelar' })}
          style={{
            background: 'transparent', border: 0, color: '#fff',
            fontSize: '1.5rem', cursor: processing ? 'default' : 'pointer',
            padding: '0.5rem', lineHeight: 1,
          }}
        >
          ✕
        </button>
        <span style={{ color: '#fff', fontWeight: 600, fontSize: '1rem' }}>
          {t('profile.crop_title', { defaultValue: 'Ajustar foto' })}
        </span>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={processing}
          aria-label={t('common.done', { defaultValue: 'Listo' })}
          style={{
            background: 'transparent', border: 0,
            color: processing ? '#888' : '#FF4D00',
            fontSize: '1rem', fontWeight: 700,
            cursor: processing ? 'default' : 'pointer',
            padding: '0.5rem',
          }}
        >
          {processing
            ? t('common.processing', { defaultValue: 'Procesando…' })
            : t('common.done', { defaultValue: 'Listo' })}
        </button>
      </div>

      {/* Crop viewport — fixed FRAME_SIZE square; image positioned absolute
          and translated by `pos`. Pointer events are captured on the
          viewport itself so dragging works regardless of which part of
          the image (or even outside it) the user grabs. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: 'relative',
          width: FRAME_SIZE,
          height: FRAME_SIZE,
          overflow: 'hidden',
          touchAction: 'none', // disable scroll/refresh while dragging
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={imageUrl}
          alt=""
          onLoad={(e) => {
            const el = e.currentTarget;
            setImgDims({ w: el.naturalWidth, h: el.naturalHeight });
          }}
          draggable={false}
          style={{
            position: 'absolute',
            width: layout.displayW,
            height: layout.displayH,
            left: (FRAME_SIZE - layout.displayW) / 2 + pos.x,
            top: (FRAME_SIZE - layout.displayH) / 2 + pos.y,
            objectFit: 'cover',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />

        {/* Circular frame outline — non-interactive overlay. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0,
            borderRadius: FRAME_RADIUS,
            border: '3px solid rgba(255,255,255,0.95)',
            pointerEvents: 'none',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
          }}
        />
      </div>

      {/* Zoom slider */}
      <div style={{ marginTop: '1.5rem', width: FRAME_SIZE, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: '0.75rem' }} aria-hidden="true">−</span>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(parseFloat(e.target.value))}
          aria-label={t('profile.crop_zoom', { defaultValue: 'Zoom' })}
          style={{ flex: 1, accentColor: '#FF4D00' }}
        />
        <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: '0.75rem' }} aria-hidden="true">+</span>
      </div>

      {/* Hint */}
      <p style={{
        color: 'rgba(255,255,255,0.75)',
        marginTop: '1rem',
        textAlign: 'center',
        padding: '0 1rem',
        fontSize: '0.875rem',
      }}>
        {t('profile.crop_hint', { defaultValue: 'Arrastrá la imagen y usá el zoom para centrar tu cara en el círculo.' })}
      </p>
    </div>
  );
}
