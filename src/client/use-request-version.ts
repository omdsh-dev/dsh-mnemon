import { useEffect, useMemo, useRef } from 'react'

export function useRequestVersion(): { begin: () => number; isCurrent: (version: number) => boolean } {
  const current = useRef(0)
  useEffect(() => () => { current.current += 1 }, [])
  return useMemo(() => ({
    begin: () => { current.current += 1; return current.current },
    isCurrent: (version: number) => current.current === version,
  }), [])
}
