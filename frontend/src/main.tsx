import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { PGliteProvider } from '@electric-sql/pglite-react'
import './styles/tokens.css'
import './index.css'
import App from './App'
import OtterMark from './components/OtterMark'
import { ConfirmProvider } from './components/ConfirmProvider'
import { getDb, type Db } from './db/pglite'

function Splash({ message }: { message: string }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6">
      <OtterMark className="h-9 w-9 text-ink" />
      <p className="font-mono text-xs text-ink-faint">{message}</p>
    </div>
  )
}

/** Boot the local database, then mount the app inside the PGlite provider. */
function Root() {
  const [db, setDb] = useState<Db | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDb()
      .then(setDb)
      .catch((e) => setError(String(e)))
  }, [])

  if (error) return <Splash message={`Couldn’t start the local database — ${error}`} />
  if (!db) return <Splash message="starting local database…" />
  return (
    <PGliteProvider db={db}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </PGliteProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
