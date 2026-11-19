import { describe, expect, it } from 'vitest'
import {
  extractDocsFormatCheckInfo,
  findDocsFormatIssues,
  type DocsFormatFile,
} from './docs-format-check'
import { README_MAX_PAGE_BYTES } from './readme/readme-layout'

function file(path: string, raw: string): DocsFormatFile {
  return { path, size: Buffer.byteLength(raw), raw, isText: true }
}

/** Run the check on a repository given as path -> content. */
function check(files: Record<string, string>, root = '') {
  const all = Object.entries(files).map(([path, raw]) => file(path, raw))
  const isOrder = (path: string): boolean => path.endsWith('/_order.yaml')
  return findDocsFormatIssues({
    pages: all.filter((entry) => /\.mdx?$/.test(entry.path)),
    orderFiles: all.filter((entry) => isOrder(entry.path)),
    specs: all.filter((entry) => /\.(json|ya?ml)$/.test(entry.path) && !isOrder(entry.path)),
    files: Object.keys(files),
    root,
  })
}

const page = (body: string, frontmatter = 'title: Page'): string => `---\n${frontmatter}\n---\n${body}\n`

describe('findDocsFormatIssues', () => {
  it('finds nothing wrong with a well-formed repository', () => {
    expect(
      check({
        'docs/_order.yaml': '- Getting Started\n- loose-page\n',
        'docs/loose-page.md': page('Plain text.'),
        'docs/Getting Started/_order.yaml': '- quick-start\n- authentication\n- sdk.md\n',
        'docs/Getting Started/quick-start.md': page(
          [
            '<Callout icon="📘" theme="info">',
            '  Read `<Tabs>` first: a tag in inline code is text.',
            '</Callout>',
            '',
            '```jsx',
            '<Tabs>',
            '  <Tab title="never closed, but this is a code sample">',
            '```',
            '',
            '<Tabs>',
            '  <Tab title="A > B">One</Tab>',
            '  <Tab',
            '    title="Two"',
            '  >',
            '    Two',
            '  </Tab>',
            '</Tabs>',
            '<Cards><Card title="Self-closing" href="/docs/sdk" /></Cards>',
            '<Image src="a.png" />',
          ].join('\n'),
          'title: Quick start\nhidden: false\nslug: quick-start\nexcerpt: ""',
        ),
        // A page with children is listed by its directory name.
        'docs/Getting Started/authentication/index.md': page('Body.'),
        'docs/Getting Started/sdk.mdx': '# No frontmatter at all\n',
        'changelogs/release.md': page('Shipped.', 'title: Release\ndate: 2026-11-02'),
        'reference/openapi.json': '{"openapi": "3.1.0", "paths": {}}',
        'reference/webhooks.yaml': 'openapi: 3.1.0\npaths: {}\n',
        'reference/_order.yaml': '',
      }),
    ).toEqual([])
  })

  it('reports frontmatter the sync cannot read, on the line that breaks it', () => {
    expect(
      check({
        'docs/a.md': '---\ntitle: A\nexcerpt: [unterminated\n---\nBody.\n',
        'docs/b.md': '---\n- a\n- b\n---\nBody.\n',
        'docs/c.md': '---\ntitle: C\n\nBody with no closing line.\n',
      }),
    ).toEqual([
      {
        path: 'docs/a.md',
        line: 4,
        message: expect.stringMatching(/^frontmatter is not valid YAML \(.+\), so Breezify does not sync this page$/),
      },
      {
        path: 'docs/b.md',
        line: 1,
        message: 'frontmatter must be a YAML mapping, so Breezify does not sync this page',
      },
      {
        path: 'docs/c.md',
        line: 1,
        message: 'frontmatter opens with "---" but no later "---" line closes it',
      },
    ])
  })

  it('reports frontmatter fields whose value is silently ignored', () => {
    const issues = check({
      'docs/a.md': page('Body.', 'title:\nhidden: yes\nslug: guides/a'),
      'docs/b.md': page('Body.', 'title: B\nhidden: "true"\ndate: someday'),
      'changelogs/c.md': page('Body.', 'title: C\ndate: someday'),
    })
    expect(issues.map((issue) => `${issue.path}:${issue.line} ${issue.message.split(';')[0]}`)).toEqual([
      'changelogs/c.md:3 "date" is not a date',
      'docs/a.md:2 "title" must be text',
      'docs/a.md:3 "hidden" must be true or false',
      'docs/a.md:4 "slug" must be one URL segment with no "/"',
    ])
  })

  it('reports a code block that is never closed, from the line it opens on', () => {
    expect(
      check({
        'docs/a.md': page(['```js', 'const closed = true', '```', '', '~~~', '```', 'still open'].join('\n')),
        // An info string does not close a block, so the last fence opens one.
        'docs/b.md': page(['```md', '```js', 'code', '```', '```'].join('\n')),
      }),
    ).toEqual([
      { path: 'docs/a.md', line: 8, message: expect.stringContaining('opened with ~~~ is never closed') },
      { path: 'docs/b.md', line: 8, message: expect.stringContaining('opened with ``` is never closed') },
    ])
  })

  it('reports components that are not closed, or closed without being opened', () => {
    expect(
      check({
        'docs/a.md': page(
          ['<Tabs>', '  <Tab title="One">', '    One', '</Tabs>', '', 'Text.', '</Callout>', '<Accordion title="Open">'].join('\n'),
        ),
      }),
    ).toEqual([
      { path: 'docs/a.md', line: 5, message: '<Tab> is never closed; add </Tab>' },
      { path: 'docs/a.md', line: 10, message: '</Callout> has no opening <Callout>' },
      { path: 'docs/a.md', line: 11, message: '<Accordion> is never closed; add </Accordion>' },
    ])
  })

  it('says nothing about components when a tag is written in a way it cannot read', () => {
    expect(
      check({
        'docs/a.md': page(['<Callout theme={{ nested: { deep: 1 } }}>', 'Text.'].join('\n')),
        // Not ReadMe components: placeholders and other JSX are left alone.
        'docs/b.md': page('Use <YOUR_API_KEY> with <TableOfContents> and <Tabby>.'),
      }),
    ).toEqual([])
  })

  it('reports merge conflict markers', () => {
    expect(
      check({
        'docs/a.md': page(['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature/x'].join('\n')),
      }).map((issue) => issue.line),
    ).toEqual([4, 8])
  })

  it('reports an order file that is not a list, or lists a page that is not there', () => {
    expect(
      check({
        'docs/_order.yaml': '- Getting Started\n- Old Category\n',
        'docs/Getting Started/_order.yaml': '- quick-start\n- renamed-page\n- quick-start\n',
        'docs/Getting Started/quick-start.md': page('Body.'),
        'docs/Getting Started/flow.png': 'binary',
        'reference/_order.yaml': 'first: api\n',
        'recipes/_order.yaml': '- a\n- [b\n',
      }),
    ).toEqual([
      { path: 'docs/_order.yaml', line: 2, message: 'lists "Old Category", but this folder has no page or folder with that name' },
      { path: 'docs/Getting Started/_order.yaml', line: 2, message: 'lists "renamed-page", but this folder has no page or folder with that name' },
      { path: 'recipes/_order.yaml', line: 3, message: expect.stringMatching(/^is not valid YAML \(.+\), so the order is ignored$/) },
      { path: 'reference/_order.yaml', line: 1, message: 'must be a YAML list of page slugs, so the order is ignored' },
    ])
  })

  it('matches order entries inside a project that lives in a subdirectory', () => {
    expect(
      check(
        {
          'site/docs/_order.yaml': '- Guides & Setup\n',
          'site/docs/Guides & Setup/_order.yaml': '- intro\n',
          'site/docs/Guides & Setup/intro.md': page('Body.'),
        },
        'site',
      ),
    ).toEqual([])
  })

  it('reports an OpenAPI file that no longer parses', () => {
    expect(
      check({
        'reference/openapi.json': '{\n  "openapi": "3.1.0",\n  "paths": {},\n}\n',
        'reference/webhooks.yaml': 'openapi: 3.1.0\npaths:\n  - [oops\n',
        // Parses, and is not an OpenAPI definition: not this check's business.
        'reference/notes.json': '["anything"]',
      }),
    ).toEqual([
      { path: 'reference/openapi.json', line: 4, message: expect.stringMatching(/^is not valid JSON \(.+\), so the API reference is not updated$/) },
      { path: 'reference/webhooks.yaml', line: 4, message: expect.stringMatching(/^is not valid YAML \(.+\), so the API reference is not updated$/) },
    ])
  })

  it('reports files the sync refuses outright', () => {
    expect(
      findDocsFormatIssues({
        pages: [
          { path: 'docs/huge.md', size: README_MAX_PAGE_BYTES + 1, raw: null, isText: true },
          { path: 'docs/binary.md', size: 12, raw: '\u0000\u0001', isText: false },
        ],
        orderFiles: [],
        specs: [{ path: 'reference/huge.json', size: 3 * 1024 * 1024, raw: null, isText: true }],
        files: [],
        root: '',
      }),
    ).toEqual([
      { path: 'docs/binary.md', line: 1, message: 'is not UTF-8 text, so Breezify does not sync it' },
      { path: 'docs/huge.md', line: 1, message: 'is larger than the 512 KB page limit, so Breezify does not sync it' },
      { path: 'reference/huge.json', line: 1, message: 'is larger than the 2 MB OpenAPI definition limit, so Breezify does not sync it' },
    ])
  })
})

describe('docsFormatCheckReport', () => {
  const issue = { path: 'docs/a.md', line: 4, message: '"hidden" must be true or false' }
  const scope = { pageCount: 12, orderFileCount: 3, specCount: 1, tooManyPages: null, truncated: false }

  it('passes when nothing is wrong', async () => {
    const { docsFormatCheckReport } = await import('./docs-format-check.server')
    const report = docsFormatCheckReport([], { mode: 'blocking', ...scope })
    expect(report.conclusion).toBe('success')
    expect(report.output.title).toBe('No formatting problems')
    expect(report.output.summary).toContain('Checked 12 pages, 3 `_order.yaml` files, 1 OpenAPI file.')
  })

  it('warns without failing, or fails, depending on the mode', async () => {
    const { docsFormatCheckReport } = await import('./docs-format-check.server')
    const warning = docsFormatCheckReport([issue], { mode: 'warning', ...scope })
    expect(warning.conclusion).toBe('neutral')
    expect(warning.output.annotations).toEqual([
      expect.objectContaining({ path: 'docs/a.md', start_line: 4, annotation_level: 'warning' }),
    ])
    const blocking = docsFormatCheckReport([issue], { mode: 'blocking', ...scope })
    expect(blocking.conclusion).toBe('failure')
    expect(blocking.output.annotations?.[0]?.annotation_level).toBe('failure')
    expect(blocking.output.title).toBe('1 formatting problem')
  })

  it('does not pass a repository with more pages than a workspace holds', async () => {
    const { docsFormatCheckReport } = await import('./docs-format-check.server')
    const report = docsFormatCheckReport([], { mode: 'blocking', ...scope, tooManyPages: 1200 })
    expect(report.conclusion).toBe('failure')
    expect(report.output.title).toBe('Too many pages')
    expect(report.output.annotations).toBeUndefined()
  })
})

describe('extractDocsFormatCheckInfo', () => {
  const base = { repository: { id: 9, full_name: 'breeze/docs' }, installation: { id: 3 } }

  it('runs for a new check suite and for a re-run of this check only', () => {
    expect(
      extractDocsFormatCheckInfo('check_suite', { ...base, action: 'requested', check_suite: { head_sha: 'abc' } }),
    ).toEqual({ installationId: 3, repoId: 9, repoFullName: 'breeze/docs', headSha: 'abc' })
    const rerun = (name: string, appId: number) =>
      extractDocsFormatCheckInfo(
        'check_run',
        { ...base, action: 'rerequested', check_run: { name, head_sha: 'abc', app: { id: appId } } },
        '77',
      )
    expect(rerun('Docs format', 77)?.headSha).toBe('abc')
    expect(rerun('Docs links', 77)).toBeNull()
    expect(rerun('Docs format', 78)).toBeNull()
    expect(extractDocsFormatCheckInfo('push', { ...base })).toBeNull()
  })
})
