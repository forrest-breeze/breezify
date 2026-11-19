import { describe, expect, it } from 'vitest'
import {
  extractDocsLinkCheckInfo,
  extractLinkTargets,
  findBrokenDocsLinks,
  type DocsLinkPage,
} from './docs-link-check'

function repository(files: Record<string, string>) {
  const pages: DocsLinkPage[] = Object.entries(files)
    .filter(([path]) => /\.mdx?$/.test(path))
    .map(([path, raw]) => ({ path, raw }))
  return { pages, files: new Set(Object.keys(files)), root: '' }
}

describe('findBrokenDocsLinks', () => {
  it('accepts every way a ReadMe page links to another page', () => {
    const broken = findBrokenDocsLinks(
      repository({
        'docs/start/quick-start.md': [
          '---',
          'title: Quick start',
          '---',
          'See [keys](api-keys), [keys](/docs/api-keys#rotate), [keys](doc:api-keys),',
          '[the versioned page](/v1.6/docs/api-keys), [the file](./api-keys.md),',
          '[auth](authentication), [settlement](merchant-settlement-overview),',
          '[an endpoint](/reference/getpayinbalance) and ![flow](../images/flow.png).',
        ].join('\n'),
        'docs/start/api-keys.md': '---\ntitle: API keys\n---\nBody.\n',
        // A page with children is linked by its directory name.
        'docs/start/authentication/index.md': '---\ntitle: Authentication\n---\nBody.\n',
        // A page can also be linked by the slug in its frontmatter.
        'docs/settlement/index.md': '---\ntitle: Overview\nslug: merchant-settlement-overview\n---\n',
        'reference/balances/getpayinbalance.md': '---\napi:\n  operationId: getPayinBalance\n---\n',
        'docs/images/flow.png': 'binary',
      }),
    )
    expect(broken).toEqual([])
  })

  it('reports a missing page or file with the line it is on', () => {
    const broken = findBrokenDocsLinks(
      repository({
        'docs/start/quick-start.md': [
          '---',
          'title: Quick start',
          '---',
          'Read [this](removed-page) first.',
          '',
          'Then [that](/docs/also-removed) and <a href="doc:gone">this</a>.',
          '![missing](./images/none.png)',
        ].join('\n'),
      }),
    )
    expect(broken).toEqual([
      { path: 'docs/start/quick-start.md', line: 4, target: 'removed-page', reason: 'no page has the slug "removed-page"' },
      { path: 'docs/start/quick-start.md', line: 6, target: '/docs/also-removed', reason: 'no page has the slug "also-removed"' },
      { path: 'docs/start/quick-start.md', line: 6, target: 'doc:gone', reason: 'no page has the slug "gone"' },
      { path: 'docs/start/quick-start.md', line: 7, target: './images/none.png', reason: 'docs/start/images/none.png does not exist' },
    ])
  })

  it('leaves alone what it cannot judge: external links, anchors and code', () => {
    const broken = findBrokenDocsLinks(
      repository({
        'docs/page.md': [
          '---',
          'title: Page',
          'link: [not prose](nowhere)',
          '---',
          '[site](https://breeze.com/nope) [mail](mailto:a@b.co) [cdn](//cdn.test/x.png)',
          '[top](#top) [app](/dashboard/settings) `[code](nowhere)`',
          '```md',
          '[inside a fence](nowhere)',
          '```',
        ].join('\n'),
      }),
    )
    expect(broken).toEqual([])
  })

  it('treats a relative link with no extension as a slug, wherever the page lives', () => {
    const broken = findBrokenDocsLinks(
      repository({
        'docs/Getting Started/a.md':
          '---\ntitle: A\n---\n[b](./phases) [category](getting-started) [typo](./phase.md)\n',
        'docs/Getting Started/deeper/phases.md': '---\ntitle: Phases\n---\n',
        'docs/Getting Started/index.md': '---\ntitle: Getting Started\n---\n',
      }),
    )
    // A link that names a file must name one that exists.
    expect(broken.map((link) => link.target)).toEqual(['./phase.md'])
  })

  it('resolves links inside a project that lives in a subdirectory', () => {
    const files = {
      'portal/docs/a.md': '---\ntitle: A\n---\n[b](b) [gone](c)\n',
      'portal/docs/b.md': '---\ntitle: B\n---\n',
      // Outside the project: not a page, so not a valid slug.
      'docs/c.md': '---\ntitle: C\n---\n',
    }
    const broken = findBrokenDocsLinks({
      pages: Object.entries(files)
        .filter(([path]) => path.startsWith('portal/'))
        .map(([path, raw]) => ({ path, raw })),
      files: new Set(Object.keys(files)),
      root: 'portal',
    })
    expect(broken.map((link) => link.target)).toEqual(['c'])
  })
})

describe('extractLinkTargets', () => {
  it('reads titles, angle brackets and several links on a line', () => {
    expect(extractLinkTargets('[a](one "Title") and [b](<two>) and ![c](three.png)')).toEqual([
      { target: 'one', line: 1 },
      { target: 'two', line: 1 },
      { target: 'three.png', line: 1 },
    ])
  })
})

describe('docsLinkCheckReport', () => {
  const link = { path: 'docs/a.md', line: 4, target: 'gone', reason: 'no page has the slug "gone"' }

  it('passes when nothing is broken', async () => {
    const { docsLinkCheckReport } = await import('./docs-link-check.server')
    const report = docsLinkCheckReport([], { mode: 'blocking', pageCount: 12, truncated: false })
    expect(report.conclusion).toBe('success')
    expect(report.output.title).toBe('No broken links')
  })

  it('warns without failing, or fails, depending on the mode', async () => {
    const { docsLinkCheckReport } = await import('./docs-link-check.server')
    const warning = docsLinkCheckReport([link], { mode: 'warning', pageCount: 12, truncated: false })
    expect(warning.conclusion).toBe('neutral')
    expect(warning.output.annotations).toEqual([
      expect.objectContaining({ path: 'docs/a.md', start_line: 4, annotation_level: 'warning' }),
    ])
    const blocking = docsLinkCheckReport([link], { mode: 'blocking', pageCount: 12, truncated: false })
    expect(blocking.conclusion).toBe('failure')
    expect(blocking.output.annotations?.[0]?.annotation_level).toBe('failure')
    expect(blocking.output.title).toBe('1 broken link')
  })
})

describe('extractDocsLinkCheckInfo', () => {
  const base = { repository: { id: 9, full_name: 'breeze/docs' }, installation: { id: 3 } }

  it('runs for a new check suite and for a re-run of this check only', () => {
    expect(
      extractDocsLinkCheckInfo('check_suite', { ...base, action: 'requested', check_suite: { head_sha: 'abc' } }),
    ).toEqual({ installationId: 3, repoId: 9, repoFullName: 'breeze/docs', headSha: 'abc' })
    const rerun = (name: string, appId: number) =>
      extractDocsLinkCheckInfo(
        'check_run',
        { ...base, action: 'rerequested', check_run: { name, head_sha: 'abc', app: { id: appId } } },
        '77',
      )
    expect(rerun('Docs links', 77)?.headSha).toBe('abc')
    expect(rerun('Some other check', 77)).toBeNull()
    expect(rerun('Docs links', 78)).toBeNull()
    expect(extractDocsLinkCheckInfo('check_suite', { ...base, action: 'completed', check_suite: { head_sha: 'abc' } })).toBeNull()
    expect(extractDocsLinkCheckInfo('push', { ...base })).toBeNull()
  })
})
