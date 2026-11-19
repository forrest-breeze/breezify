import type { PortalScopeEntry } from "@/lib/public-kb"
import {
  portalHomePosition,
  portalPagePresentation,
  portalPageSchema,
  type PortalPage,
  type PortalPagePresentation,
} from "@/lib/portal/schema"

/** One portal page, as the editor's document tree groups content by it. */
export interface PortalPageOutlinePage {
  id: string
  title: string
  slug: string
  /** Null: the page shows Home's content and has none of its own. */
  scope: PortalScopeEntry[] | null
  presentation: PortalPagePresentation
}

/** A portal's Home and its pages. */
export interface PortalPageOutline {
  slug: string
  displayName: string
  /** Home's content: the project scope. Null is the whole workspace. */
  scope: PortalScopeEntry[] | null
  /** Home's slot among `pages` in the portal's navigation order. */
  homePosition: number
  pages: PortalPageOutlinePage[]
}

/**
 * The pages stored in a portal layout. Reads only `pages` and `homePosition`
 * and skips a page that does not validate, so one malformed entry does not hide
 * the others.
 */
export function portalPageOutlineFromSpec(
  spec: unknown,
): Pick<PortalPageOutline, "pages" | "homePosition"> {
  const record =
    typeof spec === "object" && spec !== null
      ? (spec as { pages?: unknown; homePosition?: unknown })
      : {}
  const pages: PortalPage[] = []
  if (Array.isArray(record.pages)) {
    for (const raw of record.pages) {
      const parsed = portalPageSchema.safeParse(raw)
      if (parsed.success) pages.push(parsed.data)
    }
  }
  const homePosition = portalHomePosition({
    pages,
    homePosition:
      typeof record.homePosition === "number" ? record.homePosition : undefined,
  })
  return {
    homePosition,
    pages: pages.map((page) => ({
      id: page.id,
      title: page.title,
      slug: page.slug,
      scope: page.scope,
      presentation: portalPagePresentation(page),
    })),
  }
}
