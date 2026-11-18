import { NextResponse } from "next/server";
import { ROLE_RANKS, type WorkspaceRole } from "@breezify/core";

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "owners",
  admin: "admins",
  editor: "editors",
  viewer: "viewers",
  "agent-only": "agents",
};

/** True when `role` is a known workspace role ranked at or above `min`. */
export function hasWorkspaceRole(role: string | null | undefined, min: WorkspaceRole): boolean {
  if (!role || !Object.hasOwn(ROLE_RANKS, role)) return false;
  return ROLE_RANKS[role as WorkspaceRole] >= ROLE_RANKS[min];
}

/**
 * For route handlers: a 403 response when the caller's workspace role is below
 * `min`, otherwise null. Unknown roles fail closed.
 *
 *   const denied = requireWorkspaceRole(workspace.role, "editor");
 *   if (denied) return denied;
 */
export function requireWorkspaceRole(
  role: string | null | undefined,
  min: WorkspaceRole,
): NextResponse<{ error: string; code: string }> | null {
  if (hasWorkspaceRole(role, min)) return null;
  const who = min === "owner" ? "the workspace owner" : `${ROLE_LABELS[min]} and above`;
  return NextResponse.json(
    { error: `Only ${who} can do this.`, code: "insufficient_role" },
    { status: 403 },
  );
}
