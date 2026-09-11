import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Disaster City Simulator: #root element is missing from index.html')
}

// StrictMode double-mounts in development; the simulation engine lives in the
// Zustand store and is created at most once, so this is safe.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
