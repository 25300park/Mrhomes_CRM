import { useEffect, useState } from 'react'

export function useConnectivity(override?: boolean): boolean {
  const [online, setOnline] = useState(() => override ?? window.navigator.onLine)

  useEffect(() => {
    if (override !== undefined) {
      setOnline(override)
      return
    }
    const update = () => setOnline(window.navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    update()
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [override])

  return online
}
