"use client"

import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { DocumentsSubNav } from "@/components/app/documents-sub-nav"
import { documentSurfaceBase } from "@/lib/knowledge-route"

type DocumentsNavProps = Omit<
  React.ComponentProps<typeof DocumentsSubNav>,
  "routeRoot" | "projectSlug"
>

/**
 * Knowledge navigation: the document tree. The portal builder rail renders
 * this same component, so both read the one workspace-wide document/folder
 * cache. The version pill and the GitHub publish control belong to whichever
 * sidebar hosts this (its header and its footer).
 */
export function KnowledgeSubNav({
  navProps,
  treeHeader,
  className,
}: {
  /** Extra props for the document tree (search, sort, builder chrome). */
  navProps?: DocumentsNavProps
  /** Rendered above the document tree. */
  treeHeader?: React.ReactNode
  className?: string
} = {}): React.ReactElement {
  const pathname = usePathname()
  // Preview (/knowledge) and Editor (/editor) each keep their own routes.
  const base = documentSurfaceBase(pathname) ?? "/knowledge"

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {treeHeader ? <div className="shrink-0">{treeHeader}</div> : null}
      <DocumentsSubNav
        {...navProps}
        routeRoot={base === "/editor" ? "editor" : "knowledge"}
      />
    </div>
  )
}
