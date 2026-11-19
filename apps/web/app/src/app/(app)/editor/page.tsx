import type { Metadata } from "next"
import { EditorStartState } from "@/components/app/editor-start-state"
import { FileDropZone } from "@/components/app/file-drop-zone"

export const metadata: Metadata = { title: "Editor" }

// No landing page: the document tree opens its first document here.
export default function EditorPage() {
  return (
    <FileDropZone>
      <EditorStartState />
    </FileDropZone>
  )
}
