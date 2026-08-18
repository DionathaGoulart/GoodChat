// Owner console (#/admin). Answers "who is using what, and how do I get it
// back" — storage per account split into message bytes and bucket bytes, plus
// the destructive actions: purge a thread, purge everything one account took
// part in, disable or delete an account.
//
// Every destructive action goes through one confirmation dialog that spells
// out what disappears, because none of them are undoable. The Worker enforces
// the role and the hierarchy independently; this screen only reflects them.

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'
import type { AdminConversation, AdminOverview, AdminUser } from '../lib/api'
import { ApiError } from '../lib/api'
import { useSession } from '../hooks/useSession'
import { Panel } from '../components/Panel'
import { RetroIconButton } from '../components/RetroIconButton'
import { CardListSkeleton, StatTilesSkeleton } from '../components/Skeleton'
import { navigate } from '../lib/router'
import { formatRemaining } from '../lib/time'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} gb`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} mb`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kb`
  return `${bytes} b`
}

/** "1.2 mb / 5 gb" — the plan's ceiling next to what is spent of it. */
function formatUsage(used: number, limit: number | null): string {
  if (limit === null) return formatBytes(used)
  return `${formatBytes(used)} / ${formatBytes(limit)}`
}

/** Share of the ceiling, kept to one decimal while it is still small. */
function formatShare(used: number, limit: number | null): string | null {
  if (limit === null) return null
  const percent = (used / limit) * 100
  if (percent > 0 && percent < 0.1) return '<0,1% do limite'
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}% do limite`
}

function formatDate(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  })
}

interface PendingAction {
  title: string
  detail: string
  confirmLabel: string
  run: () => Promise<unknown>
}

export function AdminScreen() {
  const { user } = useSession()
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [conversations, setConversations] = useState<AdminConversation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(() => {
    setError(null)
    return Promise.all([api.adminOverview(), api.adminUsers(), api.adminConversations()])
      .then(([overviewResult, usersResult, conversationsResult]) => {
        setOverview(overviewResult)
        setUsers(usersResult.users)
        setConversations(conversationsResult.conversations)
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 403
            ? 'esta conta não é owner'
            : 'falha ao carregar o painel',
        )
      })
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Runs an action, reports its outcome, then reloads every panel. */
  const perform = useCallback(
    (label: string, action: () => Promise<unknown>) => {
      setBusy(true)
      setNotice(null)
      setError(null)
      action()
        .then(() => setNotice(`${label}: ok`))
        .catch((err: unknown) => {
          setError(err instanceof ApiError ? `${label}: ${err.message}` : `${label}: falhou`)
        })
        .finally(() => {
          setPending(null)
          setBusy(false)
          void refresh()
        })
    },
    [refresh],
  )

  if (!user) return null

  const largest = Math.max(1, ...(users ?? []).map((account) => account.total_bytes))

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-6 sm:p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
            {'>'} owner_console
          </p>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter sm:text-4xl">
            Administração
          </h1>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
            @{user.username} · owner
          </p>
        </div>
        <div className="flex gap-2">
          <RetroIconButton disabled={busy} onClick={() => void refresh()}>
            recarregar
          </RetroIconButton>
          <RetroIconButton onClick={() => navigate({ name: 'settings' })}>← voltar</RetroIconButton>
        </div>
      </header>

      {error && (
        <p className="border-2 border-error bg-error/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="border-2 border-success bg-success/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-success">
          {notice}
        </p>
      )}

      <OverviewPanel overview={overview} />

      <Panel title="contas.db">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
              {'>'} contas
            </h2>
            <p className="mt-1 text-sm opacity-70">
              Espaço por conta: mensagens (banco) + mídia (bucket).
            </p>
          </div>
          <RetroIconButton disabled={busy} onClick={() => setCreating(true)}>
            + conta
          </RetroIconButton>
        </div>

        {users === null ? (
          <CardListSkeleton label="carregando contas" rows={4} />
        ) : (
          <ul className="flex flex-col gap-3">
            {users.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                isSelf={account.id === user.id}
                largest={largest}
                busy={busy}
                onAction={setPending}
                onPerform={perform}
              />
            ))}
          </ul>
        )}
      </Panel>

      <ConversationsPanel
        conversations={conversations}
        busy={busy}
        onAction={setPending}
      />

      <MaintenancePanel busy={busy} overview={overview} onPerform={perform} />

      {pending && (
        <ConfirmDialog
          action={pending}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => perform(pending.title, pending.run)}
        />
      )}
      {creating && (
        <CreateUserDialog
          busy={busy}
          onCancel={() => setCreating(false)}
          onCreate={(input) => {
            setCreating(false)
            perform(`criar @${input.username}`, () => api.adminCreateUser(input))
          }}
        />
      )}
    </main>
  )
}

function OverviewPanel({ overview }: { overview: AdminOverview | null }) {
  if (!overview) return <StatTilesSkeleton />


  // The gap between what the index knows and what the bucket holds is exactly
  // what a reindex would absorb — surface it instead of hiding the difference.
  const drift =
    overview.bucket_bytes !== null ? overview.bucket_bytes - overview.indexed_media_bytes : null

  const tiles: { label: string; value: string; hint?: string }[] = [
    { label: 'contas', value: String(overview.users), hint: `${overview.disabled_users} desativadas` },
    {
      label: 'convidados',
      value: String(overview.temp_users),
      hint: `${overview.tombstones} contas expiradas ainda citadas`,
    },
    { label: 'conversas', value: String(overview.conversations), hint: `${overview.messages} mensagens` },
    {
      label: 'banco (dos)',
      value: formatUsage(overview.do_storage_bytes, overview.do_storage_limit_bytes),
      hint: formatShare(overview.do_storage_bytes, overview.do_storage_limit_bytes) ?? undefined,
    },
    {
      label: 'bucket',
      value:
        overview.bucket_bytes === null
          ? '—'
          : formatUsage(overview.bucket_bytes, overview.bucket_limit_bytes),
      hint:
        overview.bucket_objects === null
          ? 'b2 indisponível'
          : [
              `${overview.bucket_objects} objetos`,
              overview.bucket_bytes === null
                ? null
                : formatShare(overview.bucket_bytes, overview.bucket_limit_bytes),
            ]
              .filter(Boolean)
              .join(' · '),
    },
    {
      label: 'indexado',
      value: formatBytes(overview.indexed_media_bytes),
      hint: drift === null ? undefined : `${drift > 0 ? '+' : ''}${formatBytes(Math.abs(drift))} fora do índice`,
    },
    {
      label: 'órfãos',
      value: formatBytes(overview.unclaimed_bytes),
      hint: `${overview.unclaimed_objects} uploads sem mensagem`,
    },
  ]

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {tiles.map((tile) => (
        <div key={tile.label} className="retro-border bg-base-200 p-3 retro-shadow-sm">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
            {tile.label}
          </p>
          <p className="mt-1 break-words text-lg font-black tracking-tighter sm:text-xl">
            {tile.value}
          </p>
          {tile.hint && (
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
              {tile.hint}
            </p>
          )}
        </div>
      ))}
    </section>
  )
}

function AccountRow({
  account,
  isSelf,
  largest,
  busy,
  onAction,
  onPerform,
}: {
  account: AdminUser
  isSelf: boolean
  largest: number
  busy: boolean
  onAction: (action: PendingAction) => void
  onPerform: (label: string, action: () => Promise<unknown>) => void
}) {
  const [resetting, setResetting] = useState(false)
  // Owners are not administrable from here (the Worker refuses too), and
  // nobody deletes the account they are signed in with.
  const isOtherOwner = account.role === 'owner' && !isSelf
  const locked = isOtherOwner || busy

  return (
    <li className="retro-border bg-base-100 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm font-black uppercase tracking-widest">
            @{account.username}
            {account.role === 'owner' && (
              <span className="ml-2 bg-accent px-2 py-0.5 text-[10px] text-accent-content">
                owner
              </span>
            )}
            {account.deleted ? (
              <span className="ml-2 bg-base-300 px-2 py-0.5 text-[10px]">expirada</span>
            ) : (
              account.disabled && (
                <span className="ml-2 bg-error px-2 py-0.5 text-[10px] text-error-content">
                  desativada
                </span>
              )
            )}
            {account.is_temp && !account.deleted && account.expires_at !== null && (
              <span className="ml-2 bg-warning px-2 py-0.5 text-[10px] text-warning-content">
                convidada · {formatRemaining(account.expires_at, Date.now())}
              </span>
            )}
          </p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-50">
            {account.conversations} conversas · {account.messages} mensagens · última atividade{' '}
            {formatDate(account.last_activity_at)}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-sm font-black">{formatBytes(account.total_bytes)}</p>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-50">
            banco {formatBytes(account.db_bytes)} · bucket {formatBytes(account.media_bytes)}
          </p>
        </div>
      </div>

      <div
        className="mt-3 h-2 w-full bg-base-300"
        role="img"
        aria-label={`uso de ${formatBytes(account.total_bytes)}`}
      >
        <div
          className="h-full bg-accent"
          style={{ width: `${Math.round((account.total_bytes / largest) * 100)}%` }}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <RetroIconButton
          disabled={locked}
          onClick={() => setResetting(true)}
          title="define uma nova senha e derruba as sessões"
        >
          senha
        </RetroIconButton>
        <RetroIconButton
          disabled={locked || isSelf}
          onClick={() =>
            onPerform(`${account.disabled ? 'reativar' : 'desativar'} @${account.username}`, () =>
              api.adminUpdateUser(account.id, { disabled: !account.disabled }),
            )
          }
        >
          {account.disabled ? 'reativar' : 'desativar'}
        </RetroIconButton>
        <RetroIconButton
          disabled={locked}
          onClick={() =>
            onAction({
              title: `limpar histórico de @${account.username}`,
              detail: `Apaga as mensagens de todas as ${account.conversations} conversas em que @${account.username} participa, para os dois lados, e remove ${formatBytes(account.media_bytes)} de mídia do bucket. As contas continuam existindo e podem voltar a conversar.`,
              confirmLabel: 'limpar histórico',
              run: () => api.adminPurgeUser(account.id),
            })
          }
        >
          limpar histórico
        </RetroIconButton>
        <RetroIconButton
          disabled={locked || isSelf}
          className="hover:bg-error hover:text-error-content"
          onClick={() =>
            onAction({
              title: `excluir @${account.username}`,
              detail: `Remove a conta, suas sessões, notificações, todas as conversas de que participa e ${formatBytes(account.media_bytes)} de mídia. Não tem volta.`,
              confirmLabel: 'excluir conta',
              run: () => api.adminDeleteUser(account.id),
            })
          }
        >
          excluir
        </RetroIconButton>
      </div>

      {resetting && (
        <PasswordDialog
          username={account.username}
          busy={busy}
          onCancel={() => setResetting(false)}
          onSubmit={(password) => {
            setResetting(false)
            onPerform(`nova senha de @${account.username}`, () =>
              api.adminUpdateUser(account.id, { password }),
            )
          }}
        />
      )}
    </li>
  )
}

function ConversationsPanel({
  conversations,
  busy,
  onAction,
}: {
  conversations: AdminConversation[] | null
  busy: boolean
  onAction: (action: PendingAction) => void
}) {
  return (
    <Panel title="conversas.db">
      <div>
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
          {'>'} conversas
        </h2>
        <p className="mt-1 text-sm opacity-70">
          Cada conversa é um banco próprio, compartilhado pelos dois participantes.
        </p>
      </div>

      {conversations === null ? (
        <CardListSkeleton label="carregando conversas" />
      ) : conversations.length === 0 ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
          nenhuma conversa ainda
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {conversations.map((conversation) => (
            <li
              key={conversation.id}
              className="retro-border flex flex-wrap items-center justify-between gap-3 bg-base-100 p-3"
            >
              <div>
                <p className="font-mono text-xs font-black uppercase tracking-widest">
                  {conversation.participants.map((p) => `@${p.username}`).join(' ↔ ')}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-50">
                  {conversation.messages} mensagens · {formatBytes(conversation.storage_bytes)} ·{' '}
                  {conversation.media_objects} mídias · {formatDate(conversation.last_message_at)}
                  {conversation.unreachable && ' · indisponível'}
                </p>
              </div>
              <RetroIconButton
                disabled={busy}
                onClick={() =>
                  onAction({
                    title: `limpar ${conversation.participants.map((p) => `@${p.username}`).join(' ↔ ')}`,
                    detail: `Apaga as ${conversation.messages} mensagens desta conversa para os dois lados e remove ${conversation.media_objects} mídias do bucket.`,
                    confirmLabel: 'limpar conversa',
                    run: () => api.adminPurgeConversation(conversation.id),
                  })
                }
              >
                limpar
              </RetroIconButton>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function MaintenancePanel({
  busy,
  overview,
  onPerform,
}: {
  busy: boolean
  overview: AdminOverview | null
  onPerform: (label: string, action: () => Promise<unknown>) => void
}) {
  return (
    <Panel title="manutencao.sh">
      <div>
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
          {'>'} manutenção
        </h2>
        <p className="mt-1 text-sm opacity-70">
          A limpeza roda de hora em hora sozinha; aqui é só para adiantar.
          {overview?.retention_days
            ? ` Retenção de mídia: ${overview.retention_days} dias.`
            : ' Retenção de mídia desligada (MEDIA_RETENTION_DAYS=0).'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <RetroIconButton
          disabled={busy}
          onClick={() => onPerform('limpeza', () => api.adminCleanup())}
          title="sessões expiradas, contadores de rate limit e uploads órfãos"
        >
          rodar limpeza
        </RetroIconButton>
        <RetroIconButton
          disabled={busy}
          onClick={() => onPerform('reindexar mídia', () => api.adminReindexMedia())}
          title="indexa objetos anteriores à migration 0003"
        >
          reindexar mídia
        </RetroIconButton>
      </div>
      {overview?.legacy_media_reads === 'allow' && (
        <p className="font-mono text-[10px] uppercase leading-relaxed tracking-[0.2em] opacity-50">
          leitura legada liberada: objetos fora do índice ainda são servidos a qualquer sessão.
          reindexe e defina MEDIA_LEGACY_READS=deny para fechar.
        </p>
      )}
    </Panel>
  )
}

function ConfirmDialog({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: PendingAction
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal onCancel={onCancel}>
      <h3 className="font-mono text-sm font-black uppercase tracking-widest text-error">
        {action.title}
      </h3>
      <p className="text-sm leading-relaxed opacity-80">{action.detail}</p>
      <div className="flex justify-end gap-2">
        <RetroIconButton disabled={busy} onClick={onCancel}>
          cancelar
        </RetroIconButton>
        <RetroIconButton
          disabled={busy}
          className="bg-error text-error-content hover:bg-error"
          onClick={onConfirm}
        >
          {busy ? 'executando …' : action.confirmLabel}
        </RetroIconButton>
      </div>
    </Modal>
  )
}

function CreateUserDialog({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean
  onCancel: () => void
  onCreate: (input: { username: string; password: string; display_name?: string }) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const valid = /^[a-z0-9_]{3,20}$/.test(username.trim().toLowerCase()) && password.length >= 8

  return (
    <Modal onCancel={onCancel}>
      <h3 className="font-mono text-sm font-black uppercase tracking-widest text-accent">
        nova conta
      </h3>
      <Field label="username" hint="3-20 caracteres: a-z, 0-9, _">
        <input
          className="input input-bordered w-full font-mono lowercase"
          value={username}
          autoComplete="off"
          onChange={(event) => setUsername(event.target.value.toLowerCase())}
        />
      </Field>
      <Field label="senha" hint="mínimo 8 caracteres">
        <input
          className="input input-bordered w-full font-mono"
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label="nome de exibição" hint="opcional">
        <input
          className="input input-bordered w-full font-mono"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <RetroIconButton onClick={onCancel}>cancelar</RetroIconButton>
        <RetroIconButton
          disabled={!valid || busy}
          onClick={() =>
            onCreate({
              username: username.trim().toLowerCase(),
              password,
              display_name: displayName.trim() || undefined,
            })
          }
        >
          criar
        </RetroIconButton>
      </div>
    </Modal>
  )
}

function PasswordDialog({
  username,
  busy,
  onCancel,
  onSubmit,
}: {
  username: string
  busy: boolean
  onCancel: () => void
  onSubmit: (password: string) => void
}) {
  const [password, setPassword] = useState('')

  return (
    <Modal onCancel={onCancel}>
      <h3 className="font-mono text-sm font-black uppercase tracking-widest text-accent">
        nova senha de @{username}
      </h3>
      <p className="text-sm opacity-70">
        Todas as sessões dessa conta caem imediatamente.
      </p>
      <Field label="senha" hint="mínimo 8 caracteres">
        <input
          className="input input-bordered w-full font-mono"
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <RetroIconButton onClick={onCancel}>cancelar</RetroIconButton>
        <RetroIconButton disabled={password.length < 8 || busy} onClick={() => onSubmit(password)}>
          definir
        </RetroIconButton>
      </div>
    </Modal>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
        {label} · {hint}
      </span>
      {children}
    </label>
  )
}

/** Native <dialog> so Escape and the backdrop close it without extra wiring. */
function Modal({ onCancel, children }: { onCancel: () => void; children: ReactNode }) {
  const [element, setElement] = useState<HTMLDialogElement | null>(null)

  useEffect(() => {
    element?.showModal()
  }, [element])

  return (
    <dialog ref={setElement} className="modal" onCancel={onCancel} onClose={onCancel}>
      <div className="modal-box retro-border flex max-w-md flex-col gap-4 bg-base-100 retro-shadow">
        {children}
      </div>
      <form method="dialog" className="modal-backdrop bg-base-300/60">
        <button aria-label="fechar">fechar</button>
      </form>
    </dialog>
  )
}
