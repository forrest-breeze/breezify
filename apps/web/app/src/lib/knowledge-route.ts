// ---------------------------------------------------------------------------
// Client-side document switching for Knowledge.
//
// /knowledge/<id> is a thin shell: the server contributes nothing but
// `<DocumentEditor documentId>`, and the document itself comes from the SWR
// cache. Routing each document click through the server therefore buys nothing
// and costs a round-trip behind a loading skeleton, every time, even for a
// document opened a moment ago.
//
// Instead the Knowledge layout renders the editor from the URL (see
// KnowledgeDocumentOutlet) and document clicks update the URL with
// history.pushState. Next.js syncs pushState into usePathname, so the layout
// re-renders with the new id immediately and no request is made. Deep links,
// reloads and back/forward keep working because the URL is still the real
// route.
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Documents open under two surfaces: Preview (`/knowledge`, the portal builder)
 * and Editor (`/editor`, every workspace document). Both share this routing.
 */
export type DocumentSurfaceBase = "/knowledge" | "/editor"

const SURFACE_BASES: readonly DocumentSurfaceBase[] = ["/knowledge", "/editor"]

/** The surface a pathname belongs to, or null outside both. */
export function documentSurfaceBase(
  pathname: string | null | undefined,
): DocumentSurfaceBase | null {
  if (!pathname) return null
  return (
    SURFACE_BASES.find(
      (base) => pathname === base || pathname.startsWith(`${base}/`),
    ) ?? null
  )
}

/** The open document's id for a `/knowledge/<uuid>` or `/editor/<uuid>` path, else null. */
export function knowledgeDocumentIdFromPath(
  pathname: string | null | undefined,
): string | null {
  const base = documentSurfaceBase(pathname)
  if (!base || !pathname || pathname === base) return null
  const rest = pathname.slice(base.length + 1)
  if (rest.includes("/")) return null
  let id: string
  try {
    id = decodeURIComponent(rest)
  } catch {
    return null
  }
  return UUID_RE.test(id) ? id : null
}

export function knowledgeDocumentPath(
  id: string,
  base: DocumentSurfaceBase = "/knowledge",
): string {
  return `${base}/${encodeURIComponent(id)}`
}

/**
 * Path for opening a document from wherever the user is: stays in Editor when
 * already there, otherwise opens in Preview.
 */
export function documentPathFrom(
  pathname: string | null | undefined,
  id: string,
): string {
  return knowledgeDocumentPath(id, documentSurfaceBase(pathname) ?? "/knowledge")
}

/**
 * Whether a document can be opened without a server navigation: a surface
 * layout (which renders the editor from the URL) must already be mounted.
 */
export function canOpenKnowledgeDocumentInPlace(
  pathname: string | null | undefined,
  id: string,
): boolean {
  if (typeof window === "undefined") return false
  if (!UUID_RE.test(id)) return false
  return documentSurfaceBase(pathname) !== null
}

/**
 * Switch the open document in place, within the current surface. Callers
 * check canOpen… first. `query` (e.g. "?page=reference") is carried onto the
 * URL unchanged.
 */
export function openKnowledgeDocumentInPlace(id: string, query = ""): void {
  const path = documentPathFrom(window.location.pathname, id)
  if (
    window.location.pathname === path &&
    window.location.search === query
  ) {
    return
  }
  window.history.pushState(null, "", `${path}${query}`)
}
