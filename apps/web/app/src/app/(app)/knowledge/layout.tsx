import type { Metadata } from "next"
import { GithubHostedDocsSyncGate } from "@/components/app/github-hosted-docs-sync-gate"
import { KnowledgeShell } from "@/components/app/knowledge-shell"
import { KnowledgeDocumentOutlet } from "@/components/app/knowledge-document-outlet"
import { loadHostedDocsSyncSnapshot } from "@/lib/github/github-hosted-docs-sync-snapshot"

export const metadata: Metadata = {
  title: { default: "Knowledge", template: "%s · Knowledge" },
}

export default async function KnowledgeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Read on the server so the sync lock is part of the first HTML.
  const initialSource = await loadHostedDocsSyncSnapshot()
  return (
    <GithubHostedDocsSyncGate initialSource={initialSource}>
      <KnowledgeShell>
        <KnowledgeDocumentOutlet>{children}</KnowledgeDocumentOutlet>
      </KnowledgeShell>
    </GithubHostedDocsSyncGate>
  )
}
