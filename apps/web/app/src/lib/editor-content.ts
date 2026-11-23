import { DIRECTIVE_SOURCE } from "@/lib/document-tabs"
import { looksLikeHtml } from "@/lib/html-detection"
import { renderDocumentHtml } from "@/lib/render-document-html"

// ---------------------------------------------------------------------------
// What the editor is given for a stored document body.
//
// The editor's Markdown extension parses every string it is handed as
// Markdown, including the HTML the editor itself saved. Markdown only passes
// HTML through untouched while it is one unbroken block, and a block ends at
// the first blank line: the blank line inside a code sample, or inside a
// Mermaid diagram's source. From there on the rest of the page is read as
// Markdown text, which split code blocks in two, stripped their indentation
// and dropped diagrams every time a saved page was opened again.
//
// So saved HTML is handed over as exactly one HTML block: its line breaks are
// written as character references (the HTML parser turns them back into the
// same line breaks) and it is wrapped in a `<div>`, which starts an HTML block
// whatever the page begins with and is ignored by the editor's schema.
// ---------------------------------------------------------------------------

/**
 * Whether a stored body is HTML the editor (or a renderer) produced, as
 * opposed to Markdown that happens to contain some HTML: it is HTML from its
 * first character to its last.
 */
function isHtmlDocument(content: string): boolean {
  const trimmed = content.trim()
  return /^<[a-zA-Z]/.test(trimmed) && trimmed.endsWith(">") && looksLikeHtml(trimmed)
}

export function editorContent(content: string): string {
  // The Markdown extension does not know tab/card directives; they are
  // rendered to their HTML first.
  const source = DIRECTIVE_SOURCE.test(content) ? renderDocumentHtml(content) : content
  if (!isHtmlDocument(source)) return source
  return `<div>${source.trim().replace(/\r\n?|\n/g, "&#10;")}</div>`
}
