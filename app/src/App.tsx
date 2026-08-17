// Shell: session gate + hash routes. Login is rendered whenever the session
// is anonymous; authenticated users get list/thread by route.

import { SessionProvider, useSession } from './hooks/useSession'
import { useRoute } from './lib/router'
import { ConversationsScreen } from './screens/ConversationsScreen'
import { LoginScreen } from './screens/LoginScreen'
import { ThreadScreen } from './screens/ThreadScreen'

function Screens() {
  const { status } = useSession()
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
