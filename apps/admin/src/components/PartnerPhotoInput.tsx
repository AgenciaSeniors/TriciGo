'use client';

// ============================================================
// Photo field for /admin/partners.
//
// Two ways in, on purpose: upload a file from the disk or phone, or paste a URL
// for an image that is already hosted somewhere. The upload is the primary
// action — nobody has a bakery's photo sitting on a CDN — and the URL stays as
// the escape hatch.
//
// Picking a file opens the framing window rather than uploading straight away.
// The published box is 2.66:1, which `cover` reaches by cutting half the height
// off a 4:3 photo and about three quarters off a portrait one — so WHICH part
// survives has to be the admin's choice, not the layout's.
//
// The cropper returns a JPEG already at the published ratio and at most 1360 px
// wide, which also settles the old size problem on its own: a phone photo is
// 8-12 MB against a 5 MB bucket limit, and cropping lands far under it. That is
// why there is no separate compression step any more.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { partnerPlaceService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import PartnerPhotoCropper from './PartnerPhotoCropper';

// The carousel card in apps/client. Kept as the two numbers so the preview, the
// cropper and the app can be checked against each other by reading them.
const BOX_W = 340;
const BOX_H = 128;

interface Props {
  /** Current photo URL, uploaded or pasted. */
  value: string;
  onChange: (url: string) => void;
  /** Place id when editing; absent when creating. Only shapes the storage path. */
  placeId?: string | null;
  /** Raised while an upload is in flight so the parent can block Save. */
  onUploadingChange?: (uploading: boolean) => void;
  inputClassName?: string;
}

export default function PartnerPhotoInput({
  value,
  onChange,
  placeId,
  onUploadingChange,
  inputClassName = '',
}: Props) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  /** The picked file, held while the admin frames it. Nothing is uploaded until
   *  they confirm — cancelling leaves the existing photo untouched. */
  const [pending, setPending] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Revoke the last object URL on unmount, and whenever it is replaced.
  const setObjectUrl = useCallback((url: string | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;
    setPreview(url);
  }, []);
  useEffect(() => () => { if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current); }, []);

  /** Called with the already-cropped JPEG, at the published ratio. */
  const uploadCropped = async (blob: Blob) => {
    setPending(null);
    setError(null);
    setUploading(true);
    onUploadingChange?.(true);
    // Optimistic preview so the admin sees the crop while it uploads.
    setObjectUrl(URL.createObjectURL(blob));
    try {
      const url = await partnerPlaceService.uploadPhoto(blob, placeId);
      onChange(url);
      // Hand the <img> over to the real URL; the local preview has done its job.
      setObjectUrl(null);
    } catch (err) {
      setObjectUrl(null);   // revert — never leave a preview implying it saved
      setError(getErrorMessage(err));
    } finally {
      setUploading(false);
      onUploadingChange?.(false);
    }
  };

  const clearFileInput = () => {
    // Without this, picking the same file again fires no change event — and
    // after cancelling a crop, re-picking the same photo is the obvious retry.
    if (fileRef.current) fileRef.current.value = '';
  };

  const shown = preview ?? (value || null);

  return (
    <div>
      <span className="text-sm text-ink">Foto</span>

      <div className="mt-1 flex items-start gap-3">
        {shown ? (
          <div className="relative">
            {/* Plain <img>, not next/image: the source is an arbitrary host —
                the storage CDN or whatever URL the admin pasted — and
                next/image would need a remotePattern for each one. */}
            {/* 340/128 — the carousel card's ACTUAL box in the passenger app,
                written as those numbers so it stays traceable to the source.
                It used to be 4:3 (h-24 w-32), which showed a crop that was
                never going to be published: an admin could approve a photo
                here and have a third of it cut off in the app. A preview that
                disagrees with the real crop is worse than no preview.

                The ratio is severe on purpose — it matches the CAMPAÑAS and
                NOVEDADES cards (2.36:1 and 2.40:1), which is why the app looks
                coherent. The way to live with it is to SEE it before choosing
                the photo, which is exactly what this box now does. */}
            <img
              src={shown}
              alt=""
              className="w-56 aspect-[340/128] rounded-lg border border-line object-cover"
            />
            {!uploading && (
              <button
                type="button"
                onClick={() => { setObjectUrl(null); onChange(''); }}
                aria-label="Quitar la foto"
                className="absolute -right-2 -top-2 rounded-full bg-surface p-1 shadow ring-1 ring-line"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : (
          <div className="flex w-56 aspect-[340/128] items-center justify-center rounded-lg border border-dashed border-line text-ink-subtle">
            <ImagePlus className="h-6 w-6" />
          </div>
        )}

        <div className="flex-1">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-surface-sunken">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
            {uploading ? 'Subiendo…' : shown ? 'Cambiar foto' : 'Subir foto'}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) setPending(f); }}
            />
          </label>
          <p className="mt-1 text-xs text-ink-subtle">
            JPG, PNG o WebP. Al elegirla vas a poder encuadrarla: la tarjeta del
            pasajero es una franja apaisada, así que de una foto vertical se ve
            poco más de un cuarto — tú decides cuál.
          </p>
        </div>
      </div>

      <label className="mt-3 block text-xs text-ink-subtle">
        …o pega una URL
        <input
          className={inputClassName}
          placeholder="https://…"
          value={value}
          onChange={(e) => { setObjectUrl(null); onChange(e.target.value); }}
        />
      </label>

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {pending && (
        <PartnerPhotoCropper
          file={pending}
          aspectW={BOX_W}
          aspectH={BOX_H}
          onCancel={() => { setPending(null); clearFileInput(); }}
          onConfirm={(blob) => { clearFileInput(); void uploadCropped(blob); }}
        />
      )}
    </div>
  );
}
