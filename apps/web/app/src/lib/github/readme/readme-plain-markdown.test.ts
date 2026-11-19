import { describe, expect, it } from 'vitest'
import { looksLikeHtml } from '@/lib/html-detection'
import { readmeBodyToMarkdown } from './readme-markdown'
import { markdownWithoutHtml } from './readme-plain-markdown'

describe('markdownWithoutHtml', () => {
  it('turns line breaks into the spacing they stand for', () => {
    expect(markdownWithoutHtml('## Flow\n\n<br />\n\nFirst line<br>second line')).toBe(
      '## Flow\n\n\n\nFirst line\nsecond line',
    )
    // Inside a pipe-table row a break must not split the row.
    expect(markdownWithoutHtml('| a<br />b | c |')).toBe('| a b | c |')
  })

  it('rewrites an HTML table with Markdown cells as a pipe table', () => {
    const table = [
      '<table>',
      '  <thead>',
      '    <tr>',
      '      <th>',
      '        Name',
      '      </th>',
      '',
      '      <th>',
      '        Description',
      '      </th>',
      '    </tr>',
      '  </thead>',
      '',
      '  <tbody>',
      '    <tr>',
      '      <td>',
      '        `url`',
      '      </td>',
      '',
      '      <td>',
      '        Where to send it.<br />Must be HTTPS | TLS 1.2',
      '      </td>',
      '    </tr>',
      '  </tbody>',
      '</table>',
    ].join('\n')
    expect(markdownWithoutHtml(table).trim()).toBe(
      ['| Name | Description |', '| --- | --- |', '| `url` | Where to send it. Must be HTTPS \\| TLS 1.2 |'].join('\n'),
    )
  })

  it('converts headings and inline markup, and keeps the text of anything else', () => {
    expect(markdownWithoutHtml('<h3 id="payload">Request payload</h3>').trim()).toBe('### Request payload')
    expect(
      markdownWithoutHtml('See <a href="https://breeze.com/docs">the <b>docs</b></a> and <span class="x">this</span>.'),
    ).toBe('See [the docs](https://breeze.com/docs) and this.')
    expect(markdownWithoutHtml('<style>{`.a { color: red }`}</style>\nText')).toBe('\nText')
  })

  it('never touches code, or placeholders that only look like tags', () => {
    const source = [
      'Send `<br />` or <YOUR_API_KEY> as shown:',
      '',
      '```mermaid',
      'flowchart LR',
      '  n1["Your Users<br/>Buyers"]',
      '```',
    ].join('\n')
    expect(markdownWithoutHtml(source)).toBe(source)
  })
})

describe('readmeBodyToMarkdown', () => {
  it('produces Markdown the renderer does not mistake for HTML', () => {
    const body = [
      'Intro paragraph.',
      '',
      '<br />',
      '',
      '<Table align={["left","left"]}>',
      '  <thead>',
      '    <tr>',
      '      <th>',
      '        Field',
      '      </th>',
      '',
      '      <th>',
      '        Type',
      '      </th>',
      '    </tr>',
      '  </thead>',
      '',
      '  <tbody>',
      '    <tr>',
      '      <td>',
      '        amount',
      '      </td>',
      '',
      '      <td>',
      '        `number`',
      '      </td>',
      '    </tr>',
      '  </tbody>',
      '</Table>',
      '',
      '<HTMLBlock>{`',
      '<div class="note"><p>Settles <strong>daily</strong>.</p></div>',
      '`}</HTMLBlock>',
    ].join('\n')
    const markdown = readmeBodyToMarkdown(body)
    expect(looksLikeHtml(markdown)).toBe(false)
    expect(markdown).toContain('| Field | Type |\n| --- | --- |\n| amount | `number` |')
    expect(markdown).toContain('Settles **daily**.')
  })
})
