import { type NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireWorkspaceRole } from "@/lib/auth/workspace-role";
import { createWorkspaceDocument } from "@/lib/db/documents";
import { getPostHogClient } from "@/lib/posthog-server";
import { safeJsonBody, slugSchema } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { PUBLIC_KB_CACHE_TAG } from "@/lib/public-kb";
import { isNavigableDocument } from "@/lib/document-navigation";
import {
  REPOSITORY_HIDDEN_SELECT,
  isRepositoryHiddenDocument,
} from "@/lib/documents/repository-hidden";
import { nonPublicFolderIds } from "@/lib/folder-visibility";

export const dynamic = "force-dynamic";

const postBodySchema = z.object({
  title: z.string().trim().max(500).default("Untitled"),
  content: z.string().default(""),
  folder_id: z.string().nullable().optional(),
  id: z.string().optional(),
});

function projectSlugFromRequest(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("project");
  if (!raw) return undefined;
  const parsed = slugSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid project slug");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// GET /api/documents
// Returns all documents for the authenticated user's active workspace.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  let projectSlug: string | undefined;
  try {
    projectSlug = projectSlugFromRequest(request);
  } catch {
    return NextResponse.json({ error: "Invalid project slug" }, { status: 400 });
  }

  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);

  if (!workspace) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 },
    );
  }

  let query = supabase
    .from("documents")
    .select(
      `id, title, source, status, author, folder_id, document_type, sort_order, created_at, updated_at, ${REPOSITORY_HIDDEN_SELECT}`,
    )
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null);

  let permits: ((doc: { id: string; folder_id: string | null }) => boolean) | null =
    null;
  if (projectSlug) {
    try {
      const [
        { docScopeFilter, docScopePermits, getPublicDocScope },
        { resolvePortalProjectContentScope },
      ] = await Promise.all([
        import("@/lib/public-kb"),
        import("@/lib/portal/experiences-write"),
      ]);
      const project = await resolvePortalProjectContentScope(
        workspace.workspace_id,
        projectSlug,
      );
      // Members still see pages the public portal does not serve; they are
      // flagged below instead of dropped, and row-level access decides which
      // of them this member gets.
      const ds = await getPublicDocScope(
        workspace.workspace_id,
        project.scope,
        { includeNonPublic: true },
      );
      permits = (doc) => docScopePermits(ds, doc);
      query = query
        .in("document_type", ["source", "page"])
        .or(docScopeFilter(ds));
    } catch (err) {
      console.error("[Breezify] Failed to resolve document project scope:", err);
      return NextResponse.json(
        { error: "Invalid project scope" },
        { status: 400 },
      );
    }
  }

  const { data, error } = await query
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[Breezify] Failed to fetch documents:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 },
    );
  }

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    source: string | null;
    folder_id: string | null;
    readme_hidden?: unknown;
  }>;
  const navigableRows = rows.filter(isNavigableDocument);
  const listed = permits ? navigableRows.filter((row) => permits(row)) : navigableRows;
  // Members still see pages the public cannot: pages their repository marks
  // `hidden`, and everything in a folder that is not public. The flag lets the
  // tree show that the portal does not serve them. Decoration only, so a failed
  // folder lookup marks by the page's own flag alone.
  let nonPublicFolders = new Set<string>();
  try {
    const { data: tree, error: treeError } = await supabase
      .from("folders")
      .select("id, parent_folder_id, visibility")
      .eq("workspace_id", workspace.workspace_id);
    if (treeError) throw new Error(treeError.message);
    nonPublicFolders = nonPublicFolderIds(
      (tree ?? []) as Array<{
        id: string;
        parent_folder_id: string | null;
        visibility: string | null;
      }>,
    );
  } catch (err) {
    console.error("[Breezify] Failed to resolve folders hidden from the public:", err);
  }
  return NextResponse.json(
    listed.map(({ readme_hidden, ...row }) => ({
      ...row,
      hidden_from_public:
        isRepositoryHiddenDocument({ readme_hidden }) ||
        (row.folder_id !== null && nonPublicFolders.has(row.folder_id)),
    })),
  );
}

// ---------------------------------------------------------------------------
// POST /api/documents
// Creates a new document in the active workspace.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);

  if (!workspace) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 },
    );
  }

  const denied = requireWorkspaceRole(workspace.role, "editor");
  if (denied) return denied;

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // Empty trimmed title falls back to "Untitled" — schema already trimmed.
  const title = body.title || "Untitled";
  const content = body.content;
  const folderId = body.folder_id ?? null;
  const id = body.id;

  const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) {
    return NextResponse.json(
      { error: "Document too large", code: "oversize" },
      { status: 413 },
    );
  }

  const metadata = user.user_metadata as Record<string, unknown> | null;
  const author =
    (typeof metadata?.display_name === "string" && metadata.display_name.trim()) ||
    (typeof metadata?.full_name === "string" && metadata.full_name.trim()) ||
    (typeof metadata?.name === "string" && metadata.name.trim()) ||
    user.email ||
    "Unknown";

  let data;
  try {
    data = await createWorkspaceDocument({
      supabase,
      wsId: workspace.workspace_id,
      userId: user.id,
      author,
      title,
      content,
      folderId,
      id,
    });
  } catch (error) {
    console.error("[Breezify] Failed to create document:", error);
    return NextResponse.json(
      { error: "Failed to create document" },
      { status: 500 },
    );
  }

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: user.id,
    event: 'document_created',
    properties: {
      document_id: data.id,
      document_title: data.title,
      workspace_id: workspace.workspace_id,
      has_folder: data.folder_id !== null,
    },
  });
  await posthog.shutdown();
  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 });

  return NextResponse.json(data, { status: 201 });
}
