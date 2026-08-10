'use client';

// ============================================================
// Framing window for a partner-place photo.
//
// The carousel renders 340x128 — 2.66:1 — and fills it with `cover`, which
// crops whatever does not fit. On an ordinary photo that is severe: half the
// height of a 4:3 frame, about three quarters of a portrait one. Letting the
// admin choose WHICH part survives is the difference between a storefront and
// a picture of a doorstep.
//
// Once cropped here the uploaded file already IS 2.66:1, so `cover` downstream
// has nothing left to cut: what is framed is what ships.
//
// No crop library: the repo has none (packages/ui's AvatarCropModal is React
// Native and cannot run in the DOM), and the part that can be wrong without
// LOOKING wrong — the source rectangle — lives in @tricigo/utils under test.
// What is left here is drag, zoom and one canvas call.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, X, ZoomIn } from 'lucide-react';
import { clampCropOffset, computeCropRect, computeDisplayRect } from '@tricigo/utils';

/** 4x the 340pt card, so it stays crisp on a 3-4x phone screen. Never upscales
 *  past what the crop actually contains. */
const MAX_OUT_W = 1360;
const JPEG_QUALITY = 0.85;
const MAX_ZOOM = 4;

interface Props {
  file: File;
  /** The published window. Its ratio is what the crop produces. */
  aspectW: number;
  aspectH: number;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}

export default function PartnerPhotoCropper({ file, aspectW, aspectH, onCancel, onConfirm }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);

  // Object URL for the on-screen preview, revoked on unmount.
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // The maths works in the window's CSS pixels, so it has to be measured rather
  // than assumed — the modal is responsive.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setBox({ w: r.width, h: r.height });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [url]);

  const geom = nat && box
    ? { imgW: nat.w, imgH: nat.h, boxW: box.w, boxH: box.h }
    : null;

  // Re-clamp whenever zooming out removes the slack a pan was using; otherwise
  // the window would show empty space at the edge.
  useEffect(() => {
    if (!geom) return;
    setOffset((o) => clampCropOffset({ ...geom, zoom, offsetX: o.x, offsetY: o.y }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, nat, box]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!geom) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !geom) return;
    setOffset(clampCropOffset({
      ...geom, zoom,
      offsetX: d.ox + (e.clientX - d.startX),
      offsetY: d.oy + (e.clientY - d.startY),
    }));
  };
  const endDrag = () => { dragRef.current = null; };

  const confirm = useCallback(async () => {
    if (!geom || !url) return;
    setBusy(true);
    setError(null);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('No se pudo leer la imagen.'));
        img.src = url;
      });

      const rect = computeCropRect({ ...geom, zoom, offsetX: offset.x, offsetY: offset.y });
      // Never upscale: a small source stays its own size rather than being
      // stretched into a blurry 1360-wide file.
      const outW = Math.max(1, Math.round(Math.min(MAX_OUT_W, rect.sw)));
      const outH = Math.max(1, Math.round((outW * aspectH) / aspectW));

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('El navegador no permitió procesar la imagen.');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, outW, outH);

      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY),
      );
      if (!blob) throw new Error('No se pudo generar la imagen recortada.');
      onConfirm(blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo recortar la imagen.');
      setBusy(false);
    }
  }, [geom, url, zoom, offset, aspectW, aspectH, onConfirm]);

  // The preview is placed by the SAME function whose inverse cuts the file
  // (asserted in @tricigo/utils tests), so the frame on screen cannot drift
  // from what gets published.
  let imgStyle: React.CSSProperties = { visibility: 'hidden' };
  if (geom) {
    const d = computeDisplayRect({ ...geom, zoom, offsetX: offset.x, offsetY: offset.y });
    imgStyle = {
      position: 'absolute',
      width: d.width,
      height: d.height,
      left: d.left,
      top: d.top,
      maxWidth: 'none',
      userSelect: 'none',
      pointerEvents: 'none',
    };
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/60 p-4">
      <div className="admin-card w-full max-w-xl space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-ink">Encuadra la foto</h3>
          <button type="button" onClick={onCancel} aria-label="Cancelar" className="rounded p-1 hover:bg-surface-sunken">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-xs text-ink-subtle">
          Arrastra para mover y usa el control para acercar. Lo que quede dentro del
          marco es exactamente lo que verá el pasajero.
        </p>

        <div
          ref={boxRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="relative w-full cursor-grab touch-none overflow-hidden rounded-lg border border-line bg-surface-sunken active:cursor-grabbing"
          style={{ aspectRatio: `${aspectW} / ${aspectH}` }}
        >
          {url && (
            // Plain <img>: the source is a local object URL for a file the admin
            // just picked, which next/image cannot take.
            <img
              src={url}
              alt=""
              draggable={false}
              style={imgStyle}
              onLoad={(e) => setNat({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })}
            />
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <ZoomIn className="h-4 w-4 shrink-0" />
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full"
            aria-label="Acercar"
          />
        </label>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-line px-4 py-2 text-sm text-ink">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || !geom}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? 'Procesando…' : 'Usar esta foto'}
          </button>
        </div>
      </div>
    </div>
  );
}
