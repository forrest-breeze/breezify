import type { Metadata } from "next"
import { GithubHostedDocsSyncGate } from "@/components/app/github-hosted-docs-sync-gate"
import { KnowledgeDocumentOutlet } from "@/components/app/knowledge-document-outlet"

export const metadata: Metadata = {
  title: { default: "Editor", template: "%s · Editor" },
}

/**
 * Editor: every workspace document in the app's document tree, edited without
 * the portal preview. Preview (/knowledge) is the portal-scoped counterpart.
 */
export default function EditorLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <GithubHostedDocsSyncGate>
      <KnowledgeDocumentOutlet>{children}</KnowledgeDocumentOutlet>
    </GithubHostedDocsSyncGate>
  )
}
