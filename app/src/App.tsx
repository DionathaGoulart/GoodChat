// Shell: session gate + hash routes. Login is rendered whenever the session
// is anonymous; authenticated users get list/thread/settings by route, and
// the owner console only when the account actually carries the role (the
// Worker enforces it too — this only keeps the screen from flashing).

import { SessionProvider, useSession } from './hooks/useSession'
import { navigate, useRoute } from './lib/router'
import { AdminScreen } from './screens/AdminScreen'
import { ConversationsScreen } from './screens/ConversationsScreen'
import { LoginScreen } from './screens/LoginScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ThreadScreen } from './screens/ThreadScreen'

function Screens() {
  const { status, isOwner } = useSession()
  const route = useRoute()

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
          {'>'} goodchat_boot<span className="terminal-cursor">_</span>
        </p>
      </main>
    )
  }
  if (status === 'anonymous') return <LoginScreen />
  if (route.name === 'thread') return <ThreadScreen userId={route.userId} />
  if (route.name === 'settings') return <SettingsScreen />
  if (route.name === 'admin') {
    if (!isOwner) {
      navigate({ name: 'list' })
      return null
    }
    return <AdminScreen />
  }
  return <ConversationsScreen />
}

export default function App() {
  return (
    <SessionProvider>
      <div className="terminal-scanline opacity-10" aria-hidden="true" />
      <Screens />
    </SessionProvider>
  )
}
