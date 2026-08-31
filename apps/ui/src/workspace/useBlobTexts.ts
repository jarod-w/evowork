import { useEffect, useRef, useState } from 'react'

import type { BlobRef } from '@evowork/protocol'

import type { DaemonClient } from '../daemon/client'

/**
 * Fetches blob text through daemonClient.rpc('blob.get'). Does not poll:
 * each content_hash is requested at most once per mount.
 */
export function useBlobTexts(
  client: DaemonClient,
  connected: boolean,
  refs: readonly (BlobRef | null | undefined)[],
): Map<string, string> {
  const [texts, setTexts] = useState<Map<string, string>>(() => new Map())
  const inflight = useRef(new Set<string>())

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    for (const ref of refs) {
      if (!ref) continue
      const hash = ref.content_hash
      if (texts.has(hash) || inflight.current.has(hash)) continue
      inflight.current.add(hash)
      client
        .rpc<{ content_hash: string }, { content_hash: string; size: number; text: string }>(
          'blob.get',
          { content_hash: hash },
        )
        .then((result) => {
          if (cancelled) return
          setTexts((prev) => {
            const next = new Map(prev)
            next.set(hash, result.text)
            return next
          })
        })
        .catch(() => {
          inflight.current.delete(hash)
        })
    }
    return () => {
      cancelled = true
    }
  }, [client, connected, refs, texts])

  return texts
}
