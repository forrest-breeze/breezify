import type { Metadata } from "next"
import { GithubHostedDocsSyncGate } from "@/components/app/github-hosted-docs-sync-gate"
import { KnowledgeDocumentOutlet } from "@/components/app/knowledge-document-outlet"
import { loadHostedDocsSyncSnapshot } from "@/lib/github/github-hosted-docs-sync-snapshot"

export const metadata: Metadata = {
  title: { default: "Editor", template: "%s · Editor" },
}

/**
 * Editor: every workspace document in the app's document tree, edited without
 * the portal preview. Preview (/knowledge) is the portal-scoped counterpart.
 */
export default async function EditorLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Read on the server so the sync lock is part of the first HTML.
  const initialSource = await loadHostedDocsSyncSnapshot()
  return (
    <GithubHostedDocsSyncGate initialSource={initialSource}>
      <KnowledgeDocumentOutlet>{children}</KnowledgeDocumentOutlet>
    </GithubHostedDocsSyncGate>
  )
}
