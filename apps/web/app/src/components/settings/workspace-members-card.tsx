"use client"

import { useEffect, useId, useMemo, useState } from "react"
import Link from "next/link"
import {
  ArrowRight,
  Loader2,
  MoreHorizontal,
  Search,
  Send,
  Shield,
  UserCheck,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { InviteMemberDialog } from "@/components/app/invite-member-dialog"
import { useTeamMembers, useWorkspace } from "@/hooks/swr"
import { createClient } from "@/lib/supabase/client"
import { cn, getInitials } from "@/lib/utils"
import { canManageRole, type TeamMember, type WorkspaceRole } from "@breezify/core"
import { hasWorkspaceRole } from "@/lib/auth/workspace-role"

const STATUS_LABELS: Record<TeamMember["member_status"], string> = {
  active: "Active",
  invited: "Invited",
  expired: "Expired",
  deactivated: "Deactivated",
}

interface WorkspaceMembersCardProps {
  /** When set, only show the first N rows. A "See all" link appears when total members exceed it. */
  limit?: number
}

export function WorkspaceMembersCard({ limit }: WorkspaceMembersCardProps) {
  const { data: workspace } = useWorkspace()
  const {
    data: teamData,
    isLoading: membersLoading,
    mutate: mutateTeam,
  } = useTeamMembers()
  const hasMembersData = !!teamData
  const instanceId = useId()
  const workspaceId = workspace?.id

  const members = useMemo(() => teamData?.members ?? [], [teamData?.members])
  const currentUserId = teamData?.current_user_id ?? null
  const currentUserRole = (workspace?.user_role as WorkspaceRole) || "viewer"
  // Member management is admin/owner only (enforced in /api/team too).
  const canManageMembers = hasWorkspaceRole(currentUserRole, "admin")

  const [memberSearchQuery, setMemberSearchQuery] = useState("")
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [resendError, setResendError] = useState<{ id: string; message: string } | null>(null)
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null)
  const [showDeactivated, setShowDeactivated] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) return

    const supabase = createClient()
    const channelName = `members-card-${workspaceId}-${instanceId}`
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_members",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => void mutateTeam(),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [workspaceId, instanceId, mutateTeam])

  const filteredMembers = useMemo(() => {
    const statusRank = { active: 0, invited: 1, expired: 2, deactivated: 3 } as const
    const sorted = [...members]
      .filter((m) => showDeactivated || m.member_status !== "deactivated")
      .sort((a, b) => {
      if (a.user_id === currentUserId) return -1
      if (b.user_id === currentUserId) return 1
      const rankDiff = statusRank[a.member_status] - statusRank[b.member_status]
      if (rankDiff !== 0) return rankDiff
      return 0
    })

    if (!memberSearchQuery.trim()) return sorted

    const query = memberSearchQuery.toLowerCase().trim()
    return sorted.filter((member) => {
      const nameMatch = member.display_name?.toLowerCase().includes(query)
      const emailMatch = member.email?.toLowerCase().includes(query)
      return nameMatch || emailMatch
    })
  }, [members, currentUserId, memberSearchQuery, showDeactivated])

  const activeCount = members.filter((m) => m.member_status === "active").length
  const deactivatedCount = members.filter((m) => m.member_status === "deactivated").length

  const visibleMembers =
    limit !== undefined ? filteredMembers.slice(0, limit) : filteredMembers
  const showSeeAllLink = limit !== undefined && members.length > limit

  /** Send a member-management request; surface the API's error message. */
  const sendTeamRequest = async (
    input: string,
    init: RequestInit,
    fallbackError: string,
  ): Promise<void> => {
    setActionError(null)
    try {
      const res = await fetch(input, init)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setActionError(body.error ?? fallbackError)
      }
    } catch (err) {
      console.error("[Breezify] Member update failed:", err)
      setActionError(fallbackError)
    } finally {
      mutateTeam()
    }
  }

  const handleRoleChange = async (memberId: string, role: string) => {
    // Making someone owner demotes you to admin; confirm first.
    if (role === "owner") {
      setTransferTargetId(memberId)
      return
    }
    await sendTeamRequest(
      "/api/team",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: memberId, role }),
      },
      "Failed to update role",
    )
  }

  const handleTransferOwnership = async (memberId: string) => {
    await sendTeamRequest(
      "/api/team",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: memberId, role: "owner" }),
      },
      "Failed to transfer ownership",
    )
  }

  const handleReactivate = async (memberId: string) => {
    await sendTeamRequest(
      "/api/team",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: memberId, status: "active" }),
      },
      "Failed to reactivate member",
    )
  }

  const handleResendInvite = async (
    email: string,
    role: WorkspaceRole,
    memberId: string,
  ) => {
    setResendingId(memberId)
    setResendError(null)
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, resend: true }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setResendError({ id: memberId, message: body.error ?? "Failed to resend invite" })
        return
      }
      mutateTeam()
    } catch (err) {
      console.error("[Breezify] Failed to resend invite:", err)
      setResendError({ id: memberId, message: "Failed to resend invite" })
    } finally {
      setResendingId(null)
    }
  }

  // Pending invites are deleted; joined members are deactivated (see DELETE
  // /api/team), so the row stays and can be reactivated.
  const handleRemoveMember = async (memberId: string) => {
    await sendTeamRequest(
      `/api/team?id=${memberId}`,
      { method: "DELETE" },
      "Failed to remove member",
    )
  }

  if (!canManageMembers) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              {activeCount} active member{activeCount !== 1 ? "s" : ""}
              {deactivatedCount > 0 && ` · ${deactivatedCount} deactivated`}
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setInviteDialogOpen(true)}>
            <UserPlus className="mr-2 size-4" />
            Invite Member
          </Button>
          <InviteMemberDialog
            open={inviteDialogOpen}
            onOpenChange={setInviteDialogOpen}
          />
        </div>
      </CardHeader>
      <CardContent>
        {membersLoading && !hasMembersData ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search members by name or email..."
                className="pl-9 pr-8"
                value={memberSearchQuery}
                onChange={(e) => setMemberSearchQuery(e.target.value)}
              />
              {memberSearchQuery && (
                <button
                  onClick={() => setMemberSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            {deactivatedCount > 0 && limit === undefined && (
              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showDeactivated}
                  onChange={(e) => setShowDeactivated(e.target.checked)}
                />
                Show deactivated members ({deactivatedCount})
              </label>
            )}

            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleMembers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      {memberSearchQuery ? "No members found matching your search." : "No members found."}
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleMembers.map((member) => {
                    const isCurrentUser = member.user_id === currentUserId
                    const isDeactivated = member.member_status === "deactivated"
                    const isPending =
                      member.member_status === "invited" || member.member_status === "expired"
                    return (
                      <TableRow
                        key={member.member_id}
                        className={cn(
                          "group/row",
                          isCurrentUser && "bg-muted/30",
                          isDeactivated && "opacity-60",
                        )}
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="size-8">
                              <AvatarImage src={member.avatar_url ?? undefined} />
                              <AvatarFallback>
                                {getInitials(
                                  member.display_name ?? member.email ?? "?",
                                )}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="text-sm font-medium">
                                {member.display_name ?? member.email ?? "Invited"}
                                {isCurrentUser && (
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                                    (you)
                                  </span>
                                )}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {member.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-[10px] font-normal capitalize">
                            {member.workspace_role === "agent-only" ? "Agent Only" : member.workspace_role}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              member.member_status === "active"
                                ? "secondary"
                                : "outline"
                            }
                            className={cn(
                              "text-[10px] font-normal",
                              member.member_status === "expired" &&
                                "text-muted-foreground/70 border-dashed",
                              isDeactivated && "text-destructive border-destructive/40",
                            )}
                          >
                            {STATUS_LABELS[member.member_status] ?? member.member_status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {!isCurrentUser && canManageRole(currentUserRole, member.workspace_role) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-8 opacity-0 group-hover/row:opacity-100 data-popup-open:opacity-100 transition-opacity"
                                  >
                                    <MoreHorizontal className="size-4 text-muted-foreground" />
                                  </Button>
                                }
                              />
                              <DropdownMenuContent align="end" className="w-48">
                                {isDeactivated ? (
                                  <DropdownMenuItem onClick={() => handleReactivate(member.member_id)}>
                                    <UserCheck className="mr-2 size-4" />
                                    Reactivate
                                  </DropdownMenuItem>
                                ) : (
                                <>
                                <DropdownMenuGroup>
                                  <DropdownMenuLabel className="flex items-center gap-2">
                                    <Shield className="size-3.5" />
                                    <span>Change role</span>
                                  </DropdownMenuLabel>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuRadioGroup
                                    value={member.workspace_role}
                                    onValueChange={(value) =>
                                      handleRoleChange(member.member_id, value as string)
                                    }
                                  >
                                    {currentUserRole === "owner" && <DropdownMenuRadioItem value="owner">Owner</DropdownMenuRadioItem>}
                                    {canManageRole(currentUserRole, "admin") && <DropdownMenuRadioItem value="admin">Admin</DropdownMenuRadioItem>}
                                    {canManageRole(currentUserRole, "editor") && <DropdownMenuRadioItem value="editor">Editor</DropdownMenuRadioItem>}
                                    {canManageRole(currentUserRole, "viewer") && <DropdownMenuRadioItem value="viewer">Viewer</DropdownMenuRadioItem>}
                                    {canManageRole(currentUserRole, "agent-only") && <DropdownMenuRadioItem value="agent-only">Agent Only</DropdownMenuRadioItem>}
                                  </DropdownMenuRadioGroup>
                                </DropdownMenuGroup>
                                {isPending && member.email && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      disabled={resendingId === member.member_id}
                                      onClick={(e) => {
                                        e.preventDefault()
                                        handleResendInvite(
                                          member.email!,
                                          member.workspace_role,
                                          member.member_id,
                                        )
                                      }}
                                    >
                                      {resendingId === member.member_id ? (
                                        <Loader2 className="mr-2 size-4 animate-spin" />
                                      ) : (
                                        <Send className="mr-2 size-4" />
                                      )}
                                      Resend invite
                                    </DropdownMenuItem>
                                    {resendError?.id === member.member_id && (
                                      <p className="px-2 py-1.5 text-[10px] text-destructive leading-tight">
                                        {resendError.message}
                                      </p>
                                    )}
                                  </>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => setRemoveConfirmId(member.member_id)}
                                >
                                  <UserMinus className="mr-2 size-4" />
                                  {isPending ? "Revoke invite" : "Deactivate"}
                                </DropdownMenuItem>
                                </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>

            {showSeeAllLink && (
              <div className="flex justify-center pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  render={<Link href="/settings/workspace/members" />}
                >
                  See all {members.length} members
                  <ArrowRight className="ml-1.5 size-3.5" />
                </Button>
              </div>
            )}

            <AlertDialog
              open={!!removeConfirmId}
              onOpenChange={(open) => { if (!open) setRemoveConfirmId(null) }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {members.find((m) => m.member_id === removeConfirmId)?.member_status === "active"
                      ? "Deactivate member?"
                      : "Revoke invitation?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {(() => {
                      const m = members.find((m) => m.member_id === removeConfirmId)
                      if (!m) return ""
                      return m.member_status === "active"
                        ? `${m.display_name ?? m.email} will lose access to the workspace immediately and won't be re-added when they sign in. You can reactivate them later.`
                        : `This will revoke the pending invitation for ${m.email}.`
                    })()}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      if (removeConfirmId) handleRemoveMember(removeConfirmId)
                      setRemoveConfirmId(null)
                    }}
                  >
                    {members.find((m) => m.member_id === removeConfirmId)?.member_status === "active"
                      ? "Deactivate"
                      : "Revoke"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog
              open={!!transferTargetId}
              onOpenChange={(open) => { if (!open) setTransferTargetId(null) }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Transfer ownership?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {(() => {
                      const m = members.find((m) => m.member_id === transferTargetId)
                      if (!m) return ""
                      return `${m.display_name ?? m.email} will become the workspace owner and you will become an admin. Only the new owner can undo this.`
                    })()}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      if (transferTargetId) void handleTransferOwnership(transferTargetId)
                      setTransferTargetId(null)
                    }}
                  >
                    Transfer ownership
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
