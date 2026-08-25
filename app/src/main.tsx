import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { API_URL } from './lib/api.ts'
import { bootTheme } from './hooks/useTheme.ts'

bootTheme()

// Service worker: static-asset cache + Web Push display (phase 8). Registered
// in dev too — push and install flows are exercised against localhost.
//
// The API origin rides in the registration URL rather than being posted to the
// worker, because a push arrives when there may be no page at all: a value a
// page sent would be gone the next time the worker started, and the preview
// would silently go generic. The script URL is what the browser stores, so it
// survives every restart. In production it is empty — the Worker serves the app
// and the API is the same origin — and the URL stays exactly '/sw.js'.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register(
    API_URL ? `/sw.js?api=${encodeURIComponent(API_URL)}` : '/sw.js',
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
