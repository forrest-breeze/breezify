import type { Metadata } from "next"
import { FileDropZone } from "@/components/app/file-drop-zone"
import { KnowledgeHome } from "@/components/app/knowledge-home"

export const metadata: Metadata = { title: "Editor" }

export default function EditorPage() {
  return (
    <FileDropZone>
      <KnowledgeHome />
    </FileDropZone>
  )
}
