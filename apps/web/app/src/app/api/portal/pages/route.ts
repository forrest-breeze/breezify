import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { listPortalPageOutlines } from "@/lib/portal/experiences-write"

/**
 * The active workspace's portal pages (each project's Home and its pages, with
 * their content scopes). The editor's document tree groups content by page.
 *
 * Open to every workspace member, unlike /api/portal/projects: everyone who
 * edits documents sees the tree, and this returns only page titles, slugs and
 * folder/document ids from the member's own workspace.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 })
  }

  try {
    const projects = await listPortalPageOutlines(workspace.workspace_id)
    return NextResponse.json({ projects })
  } catch (err) {
    console.error("[Breezify] portal pages GET:", err)
    return NextResponse.json(
      { error: "Failed to load portal pages" },
      { status: 500 },
    )
  }
}
