// Tiny hash router — a handful of screens doesn't justify a router dependency.
// Routes: "#/" (conversation list) · "#/t/<userId>" (thread) ·
// "#/config" (settings) · "#/admin" (owner console).
// Login is not a route: App renders it whenever the session is anonymous.

import { useEffect, useState } from 'react'

export type Route =
  | { name: 'list' }
  | { name: 'thread'; userId: string }
  | { name: 'settings' }
  | { name: 'admin' }

function parse(hash: string): Route {
  const match = /^#\/t\/([^/]+)$/.exec(hash)
  if (match) return { name: 'thread', userId: decodeURIComponent(match[1]) }
  if (hash === '#/config') return { name: 'settings' }
  if (hash === '#/admin') return { name: 'admin' }
  return { name: 'list' }
}

function toHash(route: Route): string {
  switch (route.name) {
    case 'thread':
      return `#/t/${encodeURIComponent(route.userId)}`
    case 'settings':
      return '#/config'
    case 'admin':
      return '#/admin'
    case 'list':
      return '#/'
  }
}

export function navigate(route: Route): void {
  window.location.hash = toHash(route)
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
