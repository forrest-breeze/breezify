"use client"

import { ArrowLeft } from "lucide-react"
import { useRouter } from "next/navigation"
import { WorkspaceMembersCard } from "@/components/settings/workspace-members-card"
import { Skeleton } from "@/components/ui/skeleton"
import { useWorkspace } from "@/hooks/swr"
import { hasWorkspaceRole } from "@/lib/auth/workspace-role"

export default function WorkspaceMembersPage() {
  const router = useRouter()
  const { data: workspace, isLoading } = useWorkspace()
  const isAdmin = hasWorkspaceRole(workspace?.user_role, "admin")

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <button
          onClick={() => router.push("/settings/workspace")}
          className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to Workspace
        </button>
        <h1 className="text-xl font-semibold">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage who can access Breezify, their roles, and ownership.
          Everyone with a Breeze account joins as an editor on first sign-in.
        </p>
      </div>

      {isLoading && !workspace ? (
        <Skeleton className="h-64 w-full" />
      ) : isAdmin ? (
        <WorkspaceMembersCard />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only workspace admins and owners can manage members. Ask an admin if
          you need a different role.
        </p>
      )}
    </div>
  )
}
