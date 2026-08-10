'use client';

// ============================================================
// Photo field for /admin/partners.
//
// Two ways in, on purpose: upload a file from the disk or phone, or paste a URL
// for an image that is already hosted somewhere. The upload is the primary
// action — nobody has a bakery's photo sitting on a CDN — and the URL stays as
// the escape hatch.
//
// The file is re-encoded to JPEG and capped at 1600 px before it leaves the
// browser. A phone photo is 8-12 MB against a 5 MB bucket limit, and a rejected
// upload reads as "the button is broken" rather than "the file was too big".
// The carousel renders these at ~340 px wide, so nothing is lost.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { partnerPlaceService } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';

const MAX_EDGE_PX = 1600;
const JPEG_QUALITY = 0.85;

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

/** Re-encode to JPEG, longest edge capped. Returns the original on any failure. */
async function compress(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    // Only take the re-encode if it actually helped: a small PNG screenshot can
    // come out LARGER as a JPEG, and shipping the bigger one would be silly.
    return blob && blob.size < file.size ? blob : file;
  } catch {
    // createImageBitmap rejects on formats the browser cannot decode (some
    // HEIC). Let the original through and let the EF's MIME check be the judge —
    // it returns a precise error the admin can act on.
    return file;
  }
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
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Revoke the last object URL on unmount, and whenever it is replaced.
  const setObjectUrl = useCallback((url: string | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;
    setPreview(url);
  }, []);
  useEffect(() => () => { if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current); }, []);

  const handleFile = async (file: File) => {
    setError(null);
    setUploading(true);
    onUploadingChange?.(true);
    // Optimistic preview so the admin sees the photo while it uploads.
    setObjectUrl(URL.createObjectURL(file));
    try {
      const url = await partnerPlaceService.uploadPhoto(await compress(file), placeId);
      onChange(url);
      // Hand the <img> over to the real URL; the local preview has done its job.
      setObjectUrl(null);
    } catch (err) {
      setObjectUrl(null);   // revert — never leave a preview implying it saved
      setError(getErrorMessage(err));
    } finally {
      setUploading(false);
      onUploadingChange?.(false);
      if (fileRef.current) fileRef.current.value = '';  // allow re-picking the same file
    }
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
            <img
              src={shown}
              alt=""
              className="h-24 w-32 rounded-lg border border-line object-cover"
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
          <div className="flex h-24 w-32 items-center justify-center rounded-lg border border-dashed border-line text-ink-subtle">
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
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
            />
          </label>
          <p className="mt-1 text-xs text-ink-subtle">
            JPG, PNG o WebP. Se reduce sola antes de subir.
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
    </div>
  );
}
