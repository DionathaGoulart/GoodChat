// Profile card in the settings screen: the display name and the picture, the
// two things about an account its owner can change.
//
// Both save independently, because they fail differently: a name is a text
// field that either writes or does not, while a picture is a crop, an upload to
// the bucket and only then a write (lib/media.ts → PATCH /api/profile). Sharing
// one "salvar" button would make a failed upload look like a lost rename.
//
// The name field is not saved on every keystroke: the button is enabled only
// while the field differs from what the account holds, which also gives the
// person a way to see they have unsaved text.

import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { useSession } from '../hooks/useSession'
import { MediaError, uploadAvatar } from '../lib/media'
import { Avatar } from './Avatar'
import { Panel } from './Panel'
import { RetroIconButton } from './RetroIconButton'

const MAX_DISPLAY_NAME_LENGTH = 64

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof MediaError) return error.message
  if (error instanceof ApiError) {
    if (error.status === 0) return 'servidor inacessível — tenta de novo'
    if (error.code === 'payload_too_large') return 'imagem grande demais — escolhe outra'
    if (error.code === 'unsupported_media_type') return 'formato não aceito (jpg, png ou webp)'
    if (error.code === 'rate_limited') return 'muitos envios — espera um pouco'
  }
  return fallback
}

export function ProfileCard() {
  const { user, setProfile } = useSession()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(user?.display_name ?? '')
  const [savingName, setSavingName] = useState(false)
  const [photoState, setPhotoState] = useState<'idle' | 'working'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Another device (or the owner console) renamed the account: follow it,
  // unless there is unsaved text in the field.
  useEffect(() => {
    if (!savingName) setName(user?.display_name ?? '')
  }, [user?.display_name, savingName])

  if (!user) return null

  const trimmed = name.trim()
  const stored = user.display_name ?? ''
  const nameChanged = trimmed !== stored
  const busy = savingName || photoState === 'working'

  const saveName = () => {
    if (!nameChanged || busy) return
    setSavingName(true)
    setError(null)
    setNotice(null)
    // Empty clears it: the screens fall back to @username, which is what an
    // account that never set a name already shows.
    setProfile({ display_name: trimmed.length === 0 ? null : trimmed })
      .then(() => setNotice('nome salvo'))
      .catch((err: unknown) => setError(messageFor(err, 'não deu pra salvar o nome')))
      .finally(() => setSavingName(false))
  }

  const pickPhoto = (file: File | undefined) => {
    if (!file || busy) return
    setPhotoState('working')
    setError(null)
    setNotice(null)
    // The key is useless until the profile write adopts it — an upload that
    // stops here is swept by the worker as an unclaimed object.
    uploadAvatar(file, () => {})
      .then((key) => setProfile({ avatar_key: key }))
      .then(() => setNotice('foto atualizada'))
      .catch((err: unknown) => setError(messageFor(err, 'não deu pra trocar a foto')))
      .finally(() => setPhotoState('idle'))
  }

  const removePhoto = () => {
    if (busy || !user.avatar_key) return
    setPhotoState('working')
    setError(null)
    setNotice(null)
    setProfile({ avatar_key: null })
      .then(() => setNotice('foto removida'))
      .catch((err: unknown) => setError(messageFor(err, 'não deu pra remover a foto')))
      .finally(() => setPhotoState('idle'))
  }

  return (
    <Panel title="perfil.cfg">
      <div>
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
          {'>'} perfil
        </h2>
        <p className="mt-1 text-sm opacity-70">
          Como você aparece pra quem conversa com você. O @username não muda.
        </p>
      </div>

      {error && (
        <p className="border-2 border-error bg-error/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="border-2 border-success bg-success/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-success">
          {notice}
        </p>
      )}

      <div className="flex items-center gap-4">
        {photoState === 'working' ? (
          <span className="retro-border skeleton size-20 shrink-0" aria-label="enviando foto" />
        ) : (
          <Avatar user={user} size="lg" />
        )}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
          <div className="flex flex-wrap gap-2">
            <RetroIconButton disabled={busy} onClick={() => fileRef.current?.click()}>
              {photoState === 'working' ? 'enviando …' : user.avatar_key ? 'trocar foto' : 'add foto'}
            </RetroIconButton>
            {user.avatar_key && (
              <RetroIconButton disabled={busy} onClick={removePhoto}>
                remover
              </RetroIconButton>
            )}
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-50">
            jpg, png ou webp — recortada num quadrado de 512px
          </p>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => {
          pickPhoto(event.target.files?.[0])
          // Reset so picking the same file again still fires a change.
          event.target.value = ''
        }}
      />

      <div className="flex flex-col gap-2">
        <label
          htmlFor="display-name"
          className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] opacity-70"
        >
          nome de exibição
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="display-name"
            type="text"
            value={name}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            disabled={busy}
            placeholder={user.username}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveName()
            }}
            className="input input-bordered min-w-0 flex-1 border-2 border-base-300 bg-base-100 font-mono text-sm disabled:opacity-40"
          />
          <RetroIconButton
            disabled={busy || !nameChanged}
            onClick={saveName}
            className={nameChanged ? 'bg-accent text-accent-content' : ''}
          >
            {savingName ? 'salvando …' : 'salvar'}
          </RetroIconButton>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-50">
          vazio = aparece como @{user.username}
        </p>
      </div>
    </Panel>
  )
}
