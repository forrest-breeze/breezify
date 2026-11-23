import type { Metadata } from "next"
import { WorkspaceBranchReview } from "@/components/app/workspace-branch-review"

export const metadata: Metadata = { title: "Review" }

// The review of the working branch: what it changes on the synced version, and
// the steps that move it along (request review, merge).
export default function WorkspaceBranchReviewPage(): React.ReactElement {
  return <WorkspaceBranchReview />
}
