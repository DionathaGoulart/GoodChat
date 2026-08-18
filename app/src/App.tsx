// Shell: session gate + hash routes. Login is rendered whenever the session
// is anonymous; authenticated users get list/thread/settings by route, and
// the owner console only when the account actually carries the role (the
// Worker enforces it too — this only keeps the screen from flashing).

import { BootSkeleton } from './components/Skeleton'
import { SessionProvider, useSession } from './hooks/useSession'
import { navigate, useRoute } from './lib/router'
import { AdminScreen } from './screens/AdminScreen'
import { AppearanceScreen } from './screens/AppearanceScreen'
import { ConversationsScreen } from './screens/ConversationsScreen'
import { LoginScreen } from './screens/LoginScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ThreadScreen } from './screens/ThreadScreen'

function Screens() {
  const { status, isOwner } = useSession()
  const route = useRoute()

  // Only a cold start reaches this: with a cached account (hooks/useSession)
  // the status is already 'authenticated' and the screen below paints at once.
  if (status === 'loading') return <BootSkeleton />
  if (status === 'anonymous') return <LoginScreen />
  if (route.name === 'thread') return <ThreadScreen userId={route.userId} />
  if (route.name === 'settings') return <SettingsScreen />
  if (route.name === 'appearance') return <AppearanceScreen />
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
      {/* The CRT glass — vignette, dot grid, roll band and bezel. Mounted under
          every skin and painted only by the terminal one (styles/
          skin-terminal.css), so the shell never has to read the preference. */}
      <div className="crt" aria-hidden="true" />
      <Screens />
    </SessionProvider>
  )
}
