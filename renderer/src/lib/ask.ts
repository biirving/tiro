/**
 * The renderer's side of a streamed answer.
 */

import type { AskRequest } from '@shared/types'
import { newId } from './store'

export interface AskHandlers {
  onText: (chunk: string) => void
  onDone: () => void
  onError: (message: string, flags: { needsKey?: boolean }) => void
}

export interface RunningAsk {
  cancel: () => void
}

/**
 * Runs one request. If the main process has lost the document text — it lives in
 * memory and does not survive a restart — `reregister` puts it back and we retry once.
 */
export function runAsk(
  request: AskRequest,
  handlers: AskHandlers,
  reregister: () => Promise<boolean>,
): RunningAsk {
  let cancelled = false
  let streamId = newId()

  const attempt = async (retryOnMissingDoc: boolean): Promise<void> => {
    let failed: { message: string; needsKey?: boolean; needsDoc?: boolean } | null = null

    await window.tiro.ask(streamId, request, (event) => {
      if (cancelled) return
      if (event.type === 'text') handlers.onText(event.text)
      else if (event.type === 'error') failed = event
    })

    if (cancelled) return

    if (failed) {
      const error: { message: string; needsKey?: boolean; needsDoc?: boolean } = failed
      if (error.needsDoc && retryOnMissingDoc && (await reregister())) {
        streamId = newId()
        return attempt(false)
      }
      handlers.onError(error.message, { needsKey: error.needsKey })
      return
    }
    handlers.onDone()
  }

  void attempt(true).catch((error: unknown) => {
    if (cancelled) return
    handlers.onError(error instanceof Error ? error.message : 'Something went wrong.', {})
  })

  return {
    cancel: () => {
      cancelled = true
      window.tiro.cancelAsk(streamId)
    },
  }
}
