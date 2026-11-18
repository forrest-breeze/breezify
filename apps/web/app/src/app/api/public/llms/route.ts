import { NextResponse } from "next/server"
import { headers } from "next/headers"
import { z } from "zod"
import {
  getPublicDocument,
  getPublicDocuments,
  getPublicDocumentsWithContent,
  getPublicTaxonomy,
  isDocInScope,
} from "@/lib/public-kb"
import { DOC_REF_RE } from "@/lib/portal/doc-ref"
import { resolvePortalBase } from "@/lib/public-kb-portal-base"
import { checkPublicRateLimit } from "@/lib/public-kb-ratelimit"
import { portalDocumentToMarkdown } from "@/lib/portal/portal-doc-markdown"
import { resolvePortalPublicUrl } from "@/lib/portal/llms-txt-request"
import {
  buildPortalLlmsTxt,
  buildPortalLlmsFullTxt,
  groupPortalDocuments,
  portalDocUrl,
  selectPortalLlmsFullDocs,
  type PortalLlmsFullDoc,
} from "@/lib/portal/llms-txt"

// ---------------------------------------------------------------------------
// Machine-readable portal index — llms.txt / llms-full.txt.
//
// Reached through the proxy, never linked directly: `<portal>/llms.txt` is
// rewritten here with the resolved portal base (see lib/portal/llms-txt-request.ts).
// A page route can't answer with text/plain, which is why this lives under /api.
//
// AUTH EXCEPTION (CLAUDE.md §1): intentionally UNAUTHENTICATED, same contract as
// /api/public/search and /api/public/ask — it serves exactly what an anonymous
// visitor can already read in the portal UI. Compensated by:
//   • Zod validation at the boundary,
//   • per-IP rate limiting (the full variant renders a whole KB),
//   • published + public gating via resolvePortalBase (private/unknown → 404),
//   • scope-aware reads through lib/public-kb.ts — the single retrieval guard.
// ---------------------------------------------------------------------------

// Reads request headers + query params and rate-limits — never static.
export const dynamic = "force-dynamic"

const querySchema = z.object({
  // Portal base path: "<workspace>" or "<workspace>/<project>".
  portal: z.string().trim().min(1).max(140),
  variant: z.enum(["index", "full", "doc"]).default("index"),
  // Single-document markdown (`<portal>/doc/<ref>.md`): public slug or id.
  doc: z.string().trim().regex(DOC_REF_RE).optional(),
})

const TEXT_HEADERS_BASE = {
  // Portal content changes rarely and bots hit these files hard; let the CDN
  // absorb it while keeping the window short enough to feel live.
  "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
} as const

const TEXT_HEADERS = {
  ...TEXT_HEADERS_BASE,
  "content-type": "text/plain; charset=utf-8",
} as const

const MARKDOWN_HEADERS = {
  ...TEXT_HEADERS_BASE,
  "content-type": "text/markdown; charset=utf-8",
} as const

function textResponse(body: string, status = 200): NextResponse {
  return new NextResponse(body, { status, headers: TEXT_HEADERS })
}

async function clientIp(): Promise<string> {
  const h = await headers()
  const forwarded = h.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]?.trim() || "anon"
  return h.get("x-real-ip") || "anon"
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    portal: url.searchParams.get("portal") ?? "",
    variant: url.searchParams.get("variant") ?? "index",
    doc: url.searchParams.get("doc") ?? undefined,
  })
  if (!parsed.success) return textResponse("Not found\n", 404)
  const { portal, variant, doc: docRef } = parsed.data
  if (variant === "doc" && !docRef) return textResponse("Not found\n", 404)

  const allowed = await checkPublicRateLimit(
    `llms:${portal}:${await clientIp()}`,
    variant === "full" ? 10 : 60,
    60,
  )
  if (!allowed) {
    return textResponse("Too many requests. Please retry in a minute.\n", 429)
  }

  const resolved = await resolvePortalBase(portal)
  if (!resolved) return textResponse("Not found\n", 404)

  const { workspace, scope, base } = resolved
  const requestHeaders = await headers()
  const portalUrl = resolvePortalPublicUrl(requestHeaders, base)
  const identity = {
    name: workspace.branding.name || workspace.name,
    tagline: workspace.branding.tagline,
    portalUrl,
  }

  if (variant === "doc" && docRef) {
    // Same gates as the doc page: resolve, then require it inside the portal's
    // reachable scope (unpicked docs in an explicitDocs folder included).
    const doc = await getPublicDocument(workspace.id, docRef)
    if (
      !doc ||
      !(await isDocInScope(workspace.id, { id: doc.id, folder_id: doc.folder_id }, scope))
    ) {
      return textResponse("Not found\n", 404)
    }
    const title = doc.title?.trim() || "Untitled"
    const body = portalDocumentToMarkdown(doc.content)
    const source = portalDocUrl(portalUrl, docRef)
    return new NextResponse(`# ${title}\n\nSource: ${source}\n\n${body}\n`, {
      status: 200,
      headers: MARKDOWN_HEADERS,
    })
  }

  if (variant === "index") {
    const [taxonomy, documents] = await Promise.all([
      getPublicTaxonomy(workspace.id, scope),
      getPublicDocuments(workspace.id, scope),
    ])
    return textResponse(
      buildPortalLlmsTxt({ ...identity, taxonomy, documents }),
    )
  }

  const [taxonomy, documents] = await Promise.all([
    getPublicTaxonomy(workspace.id, scope),
    getPublicDocumentsWithContent(workspace.id, scope),
  ])
  // Reuse the index's grouping so llms-full.txt reads in the same order as the
  // portal's own navigation.
  const ordered: PortalLlmsFullDoc[] = groupPortalDocuments(
    taxonomy,
    documents,
  ).flatMap((group) =>
    group.docs.map((doc) => ({
      title: doc.title || "Untitled",
      url: portalDocUrl(portalUrl, doc.slug?.trim() || doc.id),
      section: group.heading,
      markdown: portalDocumentToMarkdown(doc.content),
      ...(doc.updated_at ? { updatedAt: doc.updated_at.slice(0, 10) } : {}),
    })),
  )
  const { included, omittedCount } = selectPortalLlmsFullDocs(ordered)
  return textResponse(
    buildPortalLlmsFullTxt({ ...identity, docs: included, omittedCount }),
  )
}
