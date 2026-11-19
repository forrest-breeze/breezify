"use client"

import DocumentLoading from "@/app/(app)/knowledge/[id]/loading"
import { useDocuments } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"

/**
 * What bare /editor shows. The document tree opens its first document as soon
 * as it loads (see DocumentsSubNav), so this is only the loading state, or a
 * short note when the workspace has no documents to open.
 */
export function EditorStartState(): React.ReactElement {
  // Same cache key as the tree. Wait for hydration: the cache is seeded from
  // localStorage on the client only, so branching on it earlier would not
  // match the server HTML.
  const hasHydrated = useHasHydrated()
  const { data } = useDocuments()

  if (hasHydrated && data?.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-24">
        <p className="text-sm text-muted-foreground">
          No documents yet. Create one from the sidebar to get started.
        </p>
      </div>
    )
  }

  return <DocumentLoading />
}
