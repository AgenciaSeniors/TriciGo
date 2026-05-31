'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { getSupabaseClient } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { AvatarCropModal } from '@/components/AvatarCropModal';

export default function EditProfilePage() {
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [originalEmail, setOriginalEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastIsSuccess, setToastIsSuccess] = useState(false);

  // ── Avatar upload + crop state ──
  // The flow mirrors mobile (apps/client/app/profile/edit.tsx):
  //   1. User clicks the avatar → hidden file input opens
  //   2. On file pick we create an object URL and open the crop modal
  //   3. The crop modal returns a JPEG blob (384×384, q=0.7 — same
  //      output spec as mobile so the avatars bucket sees consistent
  //      file sizes regardless of the upload source)
  //   4. Upload to Supabase storage `avatars/<userId>/avatar.jpg`,
  //      cache-bust the URL, persist on user_metadata + profiles row.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);
  const [avatarUrlState, setAvatarUrlState] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setAuthLoading(false);
      if (session?.user) {
        const meta = session.user.user_metadata;
        setFullName(meta?.full_name || meta?.name || '');
        setPhone(session.user.phone || meta?.phone || '');
        setEmail(session.user.email || '');
        setOriginalEmail(session.user.email || '');
        setAvatarUrlState((meta?.avatar_url as string | undefined) ?? null);
      }
    });
  }, []);

  // Revoke the object URL when the modal closes — same lifecycle the
  // browser would apply at GC, but we want it deterministic to avoid
  // memory pressure if the user opens the picker repeatedly.
  useEffect(() => {
    return () => {
      if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
    };
  }, [pendingImageUrl]);

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setToastIsSuccess(false);
      setToast(t('profile.avatar_not_image', { defaultValue: 'El archivo debe ser una imagen.' }));
      e.target.value = '';
      return;
    }
    const url = URL.createObjectURL(file);
    setPendingImageUrl(url);
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = '';
  };

  const handleCropConfirm = async (blob: Blob) => {
    if (!userId) return;
    setUploadingAvatar(true);
    try {
      const supabase = getSupabaseClient();
      const filePath = `${userId}/avatar.jpg`;
      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(filePath, blob, { contentType: 'image/jpeg', upsert: true });
      if (uploadErr) throw uploadErr;
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(filePath);
      const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

      // Persist on auth user_metadata so other clients (mobile) and
      // RLS-aware queries see the new URL.
      await supabase.auth.updateUser({ data: { avatar_url: publicUrl } });
      // Mirror to public.users.avatar_url so listings via
      // authService.getUserById() return the new URL too.
      try {
        await supabase.from('users').update({ avatar_url: publicUrl }).eq('id', userId);
      } catch { /* RLS may block depending on policy; auth metadata is the primary source */ }

      setAvatarUrlState(publicUrl);
      setUser((prev: any) => prev ? { ...prev, user_metadata: { ...(prev.user_metadata ?? {}), avatar_url: publicUrl } } : prev);
      setToastIsSuccess(true);
      setToast(t('profile.photo_updated', { defaultValue: 'Foto actualizada' }));

      // Close the modal + free the object URL.
      if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
      setPendingImageUrl(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setToastIsSuccess(false);
      setToast(msg || t('profile.avatar_upload_failed', {
        defaultValue: 'No se pudo subir la foto. Intentá con una imagen más pequeña.',
      }));
    } finally {
      setUploadingAvatar(false);
    }
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 2500);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleSave = async () => {
    if (!fullName.trim()) {
      alert(t('web.name_required', { defaultValue: 'El nombre no puede estar vacio' }));
      return;
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (phone.trim() && phoneDigits.length < 8) {
      alert(t('web.phone_invalid', { defaultValue: 'El telefono debe tener al menos 8 digitos' }));
      return;
    }
    if (email.trim() && !email.includes('@')) {
      alert(t('web.email_invalid', { defaultValue: 'Ingresa un correo electronico valido' }));
      return;
    }
    setSaving(true);
    try {
      const supabase = getSupabaseClient();
      await supabase.auth.updateUser({
        data: { full_name: fullName.trim(), phone: phone.trim() },
      });
      // Mirror the name to public.users so driver/listing views (which read
      // users.full_name, NOT auth user_metadata) see the change — same pattern
      // as the avatar mirror above. Without this, a web name edit was invisible
      // to drivers. Parity con authService.updateProfile (escribe en users).
      try {
        await supabase.from('users').update({ full_name: fullName.trim() }).eq('id', userId);
      } catch { /* RLS may block; auth metadata remains the fallback source */ }

      if (email.trim() !== originalEmail) {
        await supabase.auth.updateUser({ email: email.trim() });
      }

      setToastIsSuccess(true);
      setToast(t('web.saved', { defaultValue: 'Guardado' }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('web.save_error', { defaultValue: 'Error al guardar' });
      setToastIsSuccess(false);
      setToast(msg);
    } finally {
      setSaving(false);
    }
  };

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('common.loading', { defaultValue: 'Cargando...' })}</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{t('web.login_required_edit', { defaultValue: 'Inicia sesion para editar tu perfil' })}</p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          {t('web.login', { defaultValue: 'Iniciar sesion' })}
        </Link>
      </div>
    );
  }

  const avatarUrl = avatarUrlState ?? user?.user_metadata?.avatar_url ?? null;

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed',
          top: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          background: toastIsSuccess ? 'var(--success)' : 'var(--error)',
          color: '#fff',
          padding: '0.75rem 1.5rem',
          borderRadius: '0.75rem',
          fontSize: '0.9rem',
          fontWeight: 600,
          zIndex: 1000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {toast}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>{t('web.edit_profile', { defaultValue: 'Editar perfil' })}</h1>
      </div>

      {/* Avatar — clickable, opens hidden file input → crop modal flow.
          Mirrors mobile profile/edit which surfaces an action sheet for
          camera/gallery; web keeps it simple with the browser's native
          file picker (no camera intent on most desktop browsers, and on
          mobile browsers the picker exposes both options). */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '2rem', gap: '0.5rem' }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingAvatar}
          aria-label={t('profile.change_photo', { defaultValue: 'Cambiar foto de perfil' })}
          style={{
            position: 'relative',
            width: 96,
            height: 96,
            borderRadius: '50%',
            overflow: 'hidden',
            background: 'var(--border-light)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '3px solid var(--primary)',
            padding: 0,
            cursor: uploadingAvatar ? 'wait' : 'pointer',
          }}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <svg width="48" height="48" viewBox="0 0 24 24" fill="#ccc" stroke="none" aria-hidden="true">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
            </svg>
          )}
          {/* Camera badge overlay — visual cue that the avatar is editable */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 28, height: 28, borderRadius: '50%',
              background: 'var(--primary)', color: 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.875rem', boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
            }}
          >
            📷
          </div>
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingAvatar}
          style={{
            background: 'transparent', border: 0,
            color: uploadingAvatar ? 'var(--text-tertiary)' : 'var(--primary)',
            fontSize: '0.85rem', fontWeight: 600,
            cursor: uploadingAvatar ? 'wait' : 'pointer',
          }}
        >
          {uploadingAvatar
            ? t('profile.uploading_photo', { defaultValue: 'Subiendo…' })
            : t('profile.change_photo', { defaultValue: 'Cambiar foto' })}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onFilePicked}
          style={{ display: 'none' }}
        />
      </div>

      {/* Crop modal — only mounts when an image is pending. */}
      <AvatarCropModal
        visible={!!pendingImageUrl}
        imageUrl={pendingImageUrl}
        onCancel={() => {
          if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
          setPendingImageUrl(null);
        }}
        onConfirm={handleCropConfirm}
      />

      {/* Form */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            {t('web.full_name', { defaultValue: 'Nombre completo' })}
          </label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              border: '1px solid var(--border)',
              borderRadius: '0.75rem',
              fontSize: '0.95rem',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            {t('web.email', { defaultValue: 'Correo electronico' })}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              border: '1px solid var(--border)',
              borderRadius: '0.75rem',
              fontSize: '0.95rem',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
            {t('web.phone', { defaultValue: 'Telefono' })}
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              border: '1px solid var(--border)',
              borderRadius: '0.75rem',
              fontSize: '0.95rem',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <button
          onClick={handleSave}
          disabled={saving || !fullName.trim()}
          style={{
            marginTop: '0.5rem',
            padding: '0.875rem',
            background: 'var(--primary)',
            color: '#fff',
            border: 'none',
            borderRadius: '0.75rem',
            fontSize: '0.95rem',
            fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? t('web.saving', { defaultValue: 'Guardando...' }) : t('web.save_changes', { defaultValue: 'Guardar cambios' })}
        </button>
      </div>
    </main>
  );
}
