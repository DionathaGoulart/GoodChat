import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { bootTheme } from './hooks/useTheme.ts'

bootTheme()

// Service worker: static-asset cache + Web Push display (phase 8). Registered
// in dev too — push and install flows are exercised against localhost.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
