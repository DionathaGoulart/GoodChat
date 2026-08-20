// Push opt-in state for the UI (phase 8): reads the browser state on mount,
// exposes a single toggle. All transitions go through lib/push.ts.

import { useCallback, useEffect, useState } from 'react'
import { useSession } from './useSession'
import { currentPushState, disablePush, enablePush } from '../lib/push'
import type { PushState } from '../lib/push'

export function usePush(): {
  state: PushState | 'loading'
  busy: boolean
  toggle: () => void
} {
  // The account id is what finds this browser's key, which is what lets an
  // encrypted preview be wrapped for this subscription (lib/push.ts).
  const { user } = useSession()
  const [state, setState] = useState<PushState | 'loading'>('loading')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    currentPushState().then((s) => {
      if (!cancelled) setState(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback(() => {
    if (busy || state === 'loading' || state === 'unsupported' || state === 'denied') return
    setBusy(true)
    const action = state === 'on' ? disablePush : () => enablePush(user?.id)
    action()
      .then(setState)
      .catch(() => setState('off'))
      .finally(() => setBusy(false))
  }, [busy, state, user?.id])

  return { state, busy, toggle }
}
