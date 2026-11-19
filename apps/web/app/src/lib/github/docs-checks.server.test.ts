import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  files: {} as Record<string, string>,
}))

vi.mock('@/lib/supabase/admin', () => ({
  // Just enough of the query builder for the two lookups the checks make.
  createAdminClient: () => ({
    from: (table: string) => {
      let result = [...(state.rows[table] ?? [])]
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          result = result.filter((row) => row[column] === value)
          return builder
        },
        maybeSingle: async () => ({ data: result[0] ?? null, error: null }),
        then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
          resolve({ data: result, error: null }),
      }
      return builder
    },
  }),
}))

vi.mock('./github', () => ({
  getInstallationToken: vi.fn(async () => 'token'),
  getRepositoryCommit: vi.fn(async () => ({ commit: { tree: { sha: 'tree' } } })),
  getRepositoryTree: vi.fn(async () => ({
    sha: 'tree',
    truncated: false,
    tree: Object.entries(state.files).map(([path, content]) => ({
      path,
      type: 'blob',
      sha: path,
      size: Buffer.byteLength(content),
    })),
  })),
  getRepositoryBlob: vi.fn(async (_token: string, _repo: string, sha: string) => ({
    sha,
    size: Buffer.byteLength(state.files[sha]!),
    encoding: 'base64',
    content: Buffer.from(state.files[sha]!).toString('base64'),
  })),
}))

vi.mock('./github-checks', () => ({
  createGitHubCheckRun: vi.fn(async () => ({ id: 1 })),
}))

import { handleReadmeDocsChecks } from './docs-checks.server'
import {
  getInstallationToken,
  getRepositoryBlob,
  getRepositoryTree,
} from './github'
import { createGitHubCheckRun } from './github-checks'

const info = { installationId: 3, repoId: 9, repoFullName: 'breeze/docs', headSha: 'abc' }

function link(checks: Record<string, string> | null, format = 'readme'): void {
  state.rows = {
    github_hosted_docs_sources: [
      {
        installation_id: 3,
        repo_id: 9,
        workspace_id: 'ws-1',
        paths: ['.'],
        format,
        sync_status: 'synced',
      },
    ],
    workspaces: [{ id: 'ws-1', settings: checks ? { docs_checks: checks } : {} }],
  }
}

/** The check runs posted, by name. */
function posted(): Record<string, { conclusion: string; title: string }> {
  return Object.fromEntries(
    vi.mocked(createGitHubCheckRun).mock.calls.map(([, , input]) => [
      input.name,
      { conclusion: String(input.conclusion), title: input.output?.title ?? '' },
    ]),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  state.files = {
    'docs/_order.yaml': '- start\n',
    'docs/start.md': '---\ntitle: Start\nhidden: maybe\n---\nSee [the guide](missing-page).\n',
    'README.md': 'Not a docs page.\n',
  }
})

describe('handleReadmeDocsChecks', () => {
  it('leaves a repository alone unless it has a ReadMe-format link with a check turned on', async () => {
    state.rows = {}
    expect(await handleReadmeDocsChecks(info, ['links', 'format'])).toEqual({
      status: 'ignored',
      reason: 'unlinked',
    })
    link({ broken_links: 'blocking', formatting: 'blocking' }, 'breezify')
    expect(await handleReadmeDocsChecks(info, ['links', 'format'])).toMatchObject({ reason: 'unlinked' })
    link(null)
    expect(await handleReadmeDocsChecks(info, ['links', 'format'])).toMatchObject({ reason: 'disabled' })
    // A re-run of a check that has since been turned off.
    link({ broken_links: 'warning' })
    expect(await handleReadmeDocsChecks(info, ['format'])).toMatchObject({ reason: 'disabled' })

    expect(getInstallationToken).not.toHaveBeenCalled()
    expect(createGitHubCheckRun).not.toHaveBeenCalled()
  })

  it('posts one check run per check that is on, each in its own mode', async () => {
    link({ broken_links: 'warning', formatting: 'blocking' })
    const result = await handleReadmeDocsChecks(info, ['links', 'format'])
    expect(result).toMatchObject({ status: 'reported' })
    expect(posted()).toEqual({
      'Docs links': { conclusion: 'neutral', title: '1 broken link' },
      'Docs format': { conclusion: 'failure', title: '1 formatting problem' },
    })
    // Both checks read the page; it is fetched once.
    expect(getRepositoryTree).toHaveBeenCalledTimes(1)
    const fetched = vi.mocked(getRepositoryBlob).mock.calls.map(([, , sha]) => sha).sort()
    expect(fetched).toEqual(['docs/_order.yaml', 'docs/start.md'])
  })

  it('runs only the check that was asked for', async () => {
    link({ broken_links: 'blocking', formatting: 'warning' })
    await handleReadmeDocsChecks(info, ['format'])
    expect(posted()).toEqual({
      'Docs format': { conclusion: 'neutral', title: '1 formatting problem' },
    })
  })

  it('passes a clean commit', async () => {
    state.files['docs/start.md'] = '---\ntitle: Start\n---\nBody.\n'
    link({ formatting: 'blocking' })
    await handleReadmeDocsChecks(info, ['links', 'format'])
    expect(posted()).toEqual({
      'Docs format': { conclusion: 'success', title: 'No formatting problems' },
    })
  })

  it('still reports when the commit cannot be read, so a required check is not left waiting', async () => {
    link({ broken_links: 'warning', formatting: 'blocking' })
    vi.mocked(getRepositoryTree).mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleReadmeDocsChecks(info, ['links', 'format'])
    expect(posted()).toEqual({
      'Docs links': { conclusion: 'neutral', title: 'Docs links could not finish' },
      'Docs format': { conclusion: 'failure', title: 'Docs format could not finish' },
    })
    expect(logged).toHaveBeenCalled()
  })
})
