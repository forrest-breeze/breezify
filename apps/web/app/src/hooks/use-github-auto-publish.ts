"use client"

import { useEffect, useRef, useState } from "react"
import { AUTO_PUBLISH_IDLE_SECONDS } from "@/lib/github/docs-automation-settings"

// ---------------------------------------------------------------------------
// Auto publish: when the workspace turned it on and there are changes waiting,
// ask the server to publish once editing has stopped. The server makes the real
// decision (setting on, direct commits, no conflicts, nobody edited in the last
// little while); this hook only knows when to ask, and asks again later when
// the server says someone is still editing.
// ---------------------------------------------------------------------------

interface AutoPublishInput {
  /** Setting is on and this user may publish a ready, direct-commit link. */
  enabled: boolean
  /** The exact status reports changes waiting to be published. */
  pending: boolean
  /** Identifies the pending change set; a new value clears an earlier failure. */
  changeKey: string
  onPublished: () => Promise<unknown>
}

export function useGithubAutoPublish({
  enabled,
  pending,
  changeKey,
  onPublished,
}: AutoPublishInput): { autoPublishing: boolean; autoPublishError: string | null } {
  const [autoPublishing, setAutoPublishing] = useState(false)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  // Bumped to wait again after the server reported recent editing.
  const [retry, setRetry] = useState<{ token: number; delaySeconds: number }>({
    token: 0,
    delaySeconds: AUTO_PUBLISH_IDLE_SECONDS,
  })
  const onPublishedRef = useRef(onPublished)
  useEffect(() => {
    onPublishedRef.current = onPublished
  }, [onPublished])

  const failedForThisChange = failure?.key === changeKey
  useEffect(() => {
    if (!enabled || !pending || failedForThisChange) return
    let cancelled = false
    const timeout = window.setTimeout(async () => {
      setAutoPublishing(true)
      try {
        const response = await fetch("/api/github/hosted-docs/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auto: true }),
        })
        if (cancelled) return
        if (response.ok) {
          setFailure(null)
          await onPublishedRef.current()
          return
        }
        const body = (await response.json().catch(() => ({}))) as {
          code?: string
          error?: string
          retry_after_seconds?: number
        }
        if (cancelled) return
        if (body.code === "auto_publish_waiting" || body.code === "publish_in_progress") {
          setRetry((current) => ({
            token: current.token + 1,
            delaySeconds: Math.min(Math.max(body.retry_after_seconds ?? 15, 5), 120),
          }))
          return
        }
        if (body.code === "no_changes") {
          await onPublishedRef.current()
          return
        }
        // Anything else needs a person: stop until the change set is different.
        setFailure({
          key: changeKey,
          message: body.error ?? "Auto publish could not publish these changes.",
        })
      } catch {
        if (!cancelled) {
          setRetry((current) => ({ token: current.token + 1, delaySeconds: 60 }))
        }
      } finally {
        if (!cancelled) setAutoPublishing(false)
      }
    }, retry.delaySeconds * 1000)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [changeKey, enabled, failedForThisChange, pending, retry])

  return {
    autoPublishing,
    autoPublishError: enabled && pending && failedForThisChange ? failure!.message : null,
  }
}
