import { describe, expect, it } from 'vitest'
import { portalDocumentToMarkdown } from '@/lib/portal/portal-doc-markdown'
import { readmeBodyToMarkdown } from './readme-markdown'
import { canonicalReadmeMarkdown, preserveReadmeSource } from './readme-preserve'

// The production pairing: the editor's content read back as Markdown.
const canonical = (markdown: string): string =>
  canonicalReadmeMarkdown(markdown, portalDocumentToMarkdown)

/** The page as the editor hands it back: imported, then re-serialized. */
const asEdited = (body: string): string => canonical(readmeBodyToMarkdown(body))

const preserve = (previousBody: string, markdown: string): string | null =>
  preserveReadmeSource({ previousBody, markdown, canonical })

/** Lines of `after` that are not in `before`, and the other way round. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const left = before.split('\n')
  const right = after.split('\n')
  return {
    removed: left.filter((line) => !right.includes(line)),
    added: right.filter((line) => !left.includes(line)),
  }
}

// Written the way ReadMe writes a page: a style block the editor never shows,
// `***` rules, `*` bullets, a blank line after the frontmatter.
const GUIDE = [
  '',
  '<style>{`',
  '.mermaid-render { text-align: center; }',
  '`}</style>',
  '',
  'This guide covers pay-in and payout. Contact [sales](mailto:sales@example.com) for access.',
  '',
  '***',
  '',
  '## 1. Identity and risk',
  '',
  '* **Before pay-in:** the platform completes its checks.',
  '  * **Crypto pay-in:** full verification is required.',
  '* **Before payout:** payout checks are confirmed separately.',
  '',
  '***',
  '',
  '## 2. Pay-in',
  '',
  '| Field    | Meaning          |',
  '| :------- | :--------------- |',
  '| `amount` | Minor units      |',
  '',
  '```json',
  '{ "amount": 1000 }',
  '```',
  '',
  '1. Verify the webhook.',
  '2. Treat the signed event as authoritative.',
  '',
].join('\n')

describe('canonicalReadmeMarkdown', () => {
  it('is equal for Markdown that only differs in spelling', () => {
    expect(canonical('* one\n* two')).toBe(canonical('- one\n- two'))
    expect(canonical('***')).toBe(canonical('---'))
    expect(canonical('__bold__ and _soft_')).toBe(canonical('**bold** and *soft*'))
    expect(canonical('| a   | b |\n| :-- | - |\n| 1   | 2 |')).toBe(
      canonical('| a | b |\n| --- | --- |\n| 1 | 2 |'),
    )
    expect(canonical('wrapped\nline')).toBe(canonical('wrapped line'))
    expect(canonical('```\ncode\n```')).toBe(canonical('```plaintext\ncode\n```'))
  })

  it('follows what the editor can hold', () => {
    // Headings stop at level 3; inline code carries no other mark; a link
    // wraps italics, not the other way round.
    expect(canonical('#### Deep heading')).toBe(canonical('Deep heading'))
    expect(canonical('**`status`**: always')).toBe(canonical('`status`: always'))
    expect(canonical('_See [the guide](https://example.com/guide)._')).toBe(
      '*See*[*the guide*](https://example.com/guide)*.*',
    )
  })

  it('is different for Markdown that reads differently', () => {
    expect(canonical('* one\n* two')).not.toBe(canonical('1. one\n2. two'))
    expect(canonical('## Title')).not.toBe(canonical('### Title'))
    expect(canonical('some text')).not.toBe(canonical('some  other text'))
  })
})

describe('preserveReadmeSource', () => {
  it('gives the file back byte for byte when nothing was edited', () => {
    expect(preserve(GUIDE, asEdited(GUIDE))).toBe(GUIDE)
  })

  it('changes only the line that was edited', () => {
    const edited = asEdited(GUIDE).replace('## 1. Identity and risk', '## 1. Identity')
    const body = preserve(GUIDE, edited)!
    expect(changedLines(GUIDE, body)).toEqual({
      removed: ['## 1. Identity and risk'],
      added: ['## 1. Identity'],
    })
    // The editor's own spelling of the same page is what is not written.
    expect(edited).toContain('- **Before pay-in:**')
    expect(edited).not.toContain('<style>')
  })

  it('rewrites an edited list as a whole and nothing around it', () => {
    const edited = asEdited(GUIDE).replace('full verification is required', 'full KYC is required')
    const body = preserve(GUIDE, edited)!
    expect(changedLines(GUIDE, body)).toEqual({
      removed: [
        '* **Before pay-in:** the platform completes its checks.',
        '  * **Crypto pay-in:** full verification is required.',
        '* **Before payout:** payout checks are confirmed separately.',
      ],
      added: [
        '- **Before pay-in:** the platform completes its checks.',
        '  - **Crypto pay-in:** full KYC is required.',
        '- **Before payout:** payout checks are confirmed separately.',
      ],
    })
  })

  it('puts an added block where it was added and drops a deleted one', () => {
    const edited = asEdited(GUIDE)
      .replace('## 2. Pay-in', '## 2. Pay-in\n\nA new paragraph.')
      .replace('1. Verify the webhook.\n2. Treat the signed event as authoritative.', '')
    const body = preserve(GUIDE, edited)!
    expect(changedLines(GUIDE, body)).toEqual({
      removed: ['1. Verify the webhook.', '2. Treat the signed event as authoritative.'],
      added: ['A new paragraph.'],
    })
    expect(body).toContain('## 2. Pay-in\n\nA new paragraph.\n\n| Field    | Meaning          |')
    expect(body.endsWith('```\n')).toBe(true)
  })

  it('keeps what Breezify never shows in place when the text around it changes', () => {
    const edited = asEdited(GUIDE).replace('This guide covers', 'This page covers')
    const body = preserve(GUIDE, edited)!
    expect(body.startsWith('\n<style>{`\n.mermaid-render { text-align: center; }\n`}</style>\n\nThis page covers')).toBe(true)
    expect(changedLines(GUIDE, body).removed).toHaveLength(1)
  })

  it('keeps a component nobody edited and rewrites one that was', () => {
    const page = [
      'Intro.',
      '',
      '<Callout icon="📘" theme="info">',
      '  Sandbox keys start with `sk_test`.',
      '',
      '  Live keys start with `sk_live`.',
      '</Callout>',
      '',
      '<Tabs>',
      '  <Tab title="Node">',
      '    Install with npm.',
      '',
      '    Then import it.',
      '  </Tab>',
      '  <Tab title="Python">',
      '    Install with pip.',
      '  </Tab>',
      '</Tabs>',
      '',
      'Outro.',
      '',
    ].join('\n')
    expect(preserve(page, asEdited(page))).toBe(page)

    const outroEdited = preserve(page, asEdited(page).replace('Outro.', 'The end.'))!
    expect(changedLines(page, outroEdited)).toEqual({ removed: ['Outro.'], added: ['The end.'] })

    // An edit inside the callout replaces the callout, and only the callout.
    const calloutEdited = preserve(page, asEdited(page).replace('sk_live', 'sk_prod'))!
    expect(calloutEdited).not.toContain('<Callout')
    expect(calloutEdited).toContain('sk_prod')
    expect(calloutEdited).toContain('<Tabs>\n  <Tab title="Node">\n    Install with npm.')
    expect(calloutEdited.startsWith('Intro.\n\n> 📘')).toBe(true)
  })

  it('does not let an unclosed placeholder swallow the rest of the page', () => {
    const page = 'Send `Authorization: Bearer` with <YOUR_API_KEY> as the key.\n\n* one\n* two\n\nLast.\n'
    const body = preserve(page, asEdited(page).replace('Last.', 'Final.'))!
    expect(changedLines(page, body)).toEqual({ removed: ['Last.'], added: ['Final.'] })
  })

  it('writes the same file again when asked twice', () => {
    const edited = asEdited(GUIDE).replace('## 2. Pay-in', '## 2. Paying in\n\nNew here.')
    const once = preserve(GUIDE, edited)!
    expect(preserve(once, edited)).toBe(once)
  })

  it('reads back as exactly the edited page', () => {
    const edited = asEdited(GUIDE)
      .replace('## 1. Identity and risk', '## 1. Identity')
      .replace('Minor units', 'Smallest unit')
    const body = preserve(GUIDE, edited)!
    expect(asEdited(body)).toBe(canonical(edited))
  })

  it('returns null when nothing of the file is left', () => {
    expect(preserve('Old text.\n', 'Entirely new text.')).toBeNull()
    expect(preserve('', 'Anything.')).toBeNull()
  })
})
