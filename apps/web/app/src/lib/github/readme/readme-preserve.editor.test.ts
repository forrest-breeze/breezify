// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Link from '@tiptap/extension-link'
import { TableKit } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { Markdown } from 'tiptap-markdown'
import { MathBlock, MathInline } from '@/components/app/editor/math-extension'
import { MediaImage, MediaVideo } from '@/components/app/editor/media-extension'
import { MermaidDiagram } from '@/components/app/editor/mermaid-extension'
import { documentHtmlToMarkdown } from '@/lib/document-export'
import { HeadingWithId } from '@/tiptap/extensions/heading-with-id'
import { PageBreak } from '@/tiptap/extensions/page-break'
import { readmeBodyToMarkdown } from './readme-markdown'
import { canonicalReadmeMarkdown, preserveReadmeSource } from './readme-preserve'

// The comparison in readme-preserve.ts works because it renders Markdown the
// way the editor saves it. This runs the editor itself, so a change in how it
// (or a Tiptap upgrade) serializes a page shows up here and not as publishes
// that rewrite lines nobody edited.
//
// The extensions mirror the content schema in
// components/app/editor/tiptap-editor.tsx; keep the two in step.
function savedByEditor(storedMarkdown: string): string {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, link: false }),
      HeadingWithId.configure({ levels: [1, 2, 3] }),
      CodeBlockLowlight.configure({ lowlight: createLowlight(common), defaultLanguage: 'plaintext' }),
      Markdown.configure({ html: true }),
      Link.configure({ openOnClick: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      MediaImage,
      MediaVideo,
      MathBlock,
      MathInline,
      MermaidDiagram,
      PageBreak,
    ],
    content: storedMarkdown,
  })
  const html = editor.getHTML()
  editor.destroy()
  return html
}

const toMarkdown = (content: string | null | undefined): string =>
  documentHtmlToMarkdown((content ?? '').trim())
const canonical = (markdown: string): string => canonicalReadmeMarkdown(markdown, toMarkdown)

/** What a publish would write for `body` once the editor has saved `edit` of it. */
function publishedBody(body: string, edit: (saved: string) => string = (saved) => saved): string | null {
  const saved = toMarkdown(savedByEditor(readmeBodyToMarkdown(body)))
  return preserveReadmeSource({ previousBody: body, markdown: edit(saved), canonical })
}

const PAGE = [
  '',
  '<style>{`',
  '.mermaid-render { text-align: center; }',
  '`}</style>',
  '',
  'Contact [sales](mailto:sales@example.com) for access, or read _the [API guide](https://example.com/api)._',
  '',
  '***',
  '',
  '## 1. Fields',
  '',
  '* **`status`**: always `SUCCEEDED`',
  '  * **Nested:** with a child item',
  '* __Second__ item',
  '',
  '#### Payload',
  '',
  '1. **If there is partial data**',
  '',
  '   The form is prefilled.',
  '',
  '   1. First nested step',
  '   2. Second nested step',
  '',
  '2. **Otherwise**',
  '',
  '| Field    | Meaning     |',
  '| :------- | :---------- |',
  '| `amount` | Minor units |',
  '',
  '```',
  'no language',
  '```',
  '',
  '```json',
  '{ "amount": 1000 }',
  '```',
  '',
  '<Callout icon="📘" theme="info">',
  '  Sandbox keys start with `sk_test`.',
  '</Callout>',
  '',
  '> A plain quote.',
  '',
  'Last paragraph.',
  '',
].join('\n')

describe('preserveReadmeSource with the real editor', () => {
  it('recognises a page the editor merely loaded and saved as unedited', () => {
    expect(publishedBody(PAGE)).toBe(PAGE)
  })

  it('changes one line for a one-line edit', () => {
    const body = publishedBody(PAGE, (saved) => {
      expect(saved).toContain('## 1. Fields')
      return saved.replace('## 1. Fields', '## 1. Field reference')
    })
    expect(body).toBe(PAGE.replace('## 1. Fields', '## 1. Field reference'))
  })
})
