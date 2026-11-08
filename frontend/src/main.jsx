import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

let initial = {};
try { initial = JSON.parse(document.getElementById('employer-bootstrap')?.textContent || '{}'); } catch { /* Public API can recover invalid bootstrap data. */ }

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App initialEmployer={initial.employer} initialEmployers={initial.employers} />
  </StrictMode>,
)
