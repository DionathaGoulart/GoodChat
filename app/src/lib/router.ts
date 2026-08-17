// Tiny hash router — three screens don't justify a router dependency.
// Routes: "#/" (conversation list) · "#/t/<userId>" (thread with that user).
// Login is not a route: App renders it whenever the session is anonymous.

import { useEffect, useState } from 'react'

export type Route = { name: 'list' } | { name: 'thread'; userId: string }

function parse(hash: string): Route {
  const match = /^#\/t\/([^/]+)$/.exec(hash)
  if (match) return { name: 'thread', userId: decodeURIComponent(match[1]) }
  return { name: 'list' }
}

export function navigate(route: Route): void {
  window.location.hash = route.name === 'thread' ? `#/t/${encodeURIComponent(route.userId)}` : '#/'
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
