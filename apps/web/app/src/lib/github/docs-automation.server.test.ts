import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubHostedDocsSourceRow } from '@breezify/core'
import { autoPublishRefusal, listDocumentCoAuthors } from './docs-automation.server'

type Rows = Record<string, Array<Record<string, unknown>>>

/** Just enough of the query builder for the lookups under test. */
function fakeAdmin(rows: Rows): SupabaseClient {
  const query = (table: string) => {
    let result = [...(rows[table] ?? [])]
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        result = result.filter((row) => row[column] === value)
        return builder
      },
      in: (column: string, values: unknown[]) => {
        result = result.filter((row) => values.includes(row[column]))
        return builder
      },
      not: (column: string) => {
        result = result.filter((row) => row[column] !== null && row[column] !== undefined)
        return builder
      },
      order: (column: string, options: { ascending: boolean }) => {
        result.sort((a, b) =>
          String(a[column]).localeCompare(String(b[column])) * (options.ascending ? 1 : -1),
        )
        return builder
      },
      limit: (count: number) => {
        result = result.slice(0, count)
        return builder
      },
      maybeSingle: async () => ({ data: result[0] ?? null, error: null }),
      then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
        resolve({ data: result, error: null }),
    }
    return builder
  }
  return { from: query } as unknown as SupabaseClient
}

const NOW = Date.parse('2026-11-20T12:00:00Z')
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString()

function source(overrides: Partial<GitHubHostedDocsSourceRow> = {}): GitHubHostedDocsSourceRow {
  return {
    id: 'source-1',
    workspace_id: 'ws-1',
    publish_mode: 'direct',
    conflict_count: 0,
    ...overrides,
  } as GitHubHostedDocsSourceRow
}

function workspace(autoPublish: boolean): Rows {
  return {
    workspaces: [{ id: 'ws-1', settings: { github_publishing: { auto_publish: autoPublish } } }],
    documents: [{ workspace_id: 'ws-1', updated_at: ago(600) }],
    folders: [{ workspace_id: 'ws-1', updated_at: ago(900) }],
  }
}

describe('autoPublishRefusal', () => {
  it('lets a publish through only when the workspace asked for it and editing has stopped', async () => {
    expect(await autoPublishRefusal(fakeAdmin(workspace(true)), source(), NOW)).toBeNull()
    expect(await autoPublishRefusal(fakeAdmin(workspace(false)), source(), NOW)).toMatchObject({
      code: 'auto_publish_disabled',
    })
  })

  it('never publishes through a pull request link or past an open conflict', async () => {
    const admin = fakeAdmin(workspace(true))
    expect(
      await autoPublishRefusal(admin, source({ publish_mode: 'pull_request' }), NOW),
    ).toMatchObject({ code: 'auto_publish_requires_direct' })
    expect(await autoPublishRefusal(admin, source({ conflict_count: 2 }), NOW)).toMatchObject({
      code: 'auto_publish_conflicts',
    })
  })

  it('waits while someone is still editing a page or a folder', async () => {
    const rows = workspace(true)
    rows.folders = [{ workspace_id: 'ws-1', updated_at: ago(10) }]
    expect(await autoPublishRefusal(fakeAdmin(rows), source(), NOW)).toEqual({
      code: 'auto_publish_waiting',
      error: expect.any(String),
      retry_after_seconds: 35,
    })
  })
})

describe('listDocumentCoAuthors', () => {
  it('credits only people who edited after the page last matched the repository', async () => {
    const admin = fakeAdmin({
      documents: [
        { id: 'doc-1', workspace_id: 'ws-1', source_metadata: { readme_synced_at: ago(3600) } },
        // Synced before the timestamp was recorded: uses the fallback.
        { id: 'doc-2', workspace_id: 'ws-1', source_metadata: {} },
      ],
      document_versions: [
        { workspace_id: 'ws-1', document_id: 'doc-1', edited_by: 'u-old', created_at: ago(7200) },
        { workspace_id: 'ws-1', document_id: 'doc-1', edited_by: 'u-ada', created_at: ago(600) },
        { workspace_id: 'ws-1', document_id: 'doc-1', edited_by: 'u-ada', created_at: ago(300) },
        { workspace_id: 'ws-1', document_id: 'doc-2', edited_by: 'u-grace', created_at: ago(100) },
        { workspace_id: 'ws-1', document_id: 'doc-2', edited_by: 'u-old', created_at: ago(5000) },
        { workspace_id: 'ws-1', document_id: 'doc-1', edited_by: null, created_at: ago(50) },
        { workspace_id: 'ws-1', document_id: 'doc-9', edited_by: 'u-other', created_at: ago(50) },
      ],
      profiles: [
        { user_id: 'u-ada', display_name: 'Ada Lovelace', email: 'ada@breeze.test' },
        { user_id: 'u-grace', display_name: null, email: 'grace@breeze.test' },
        { user_id: 'u-old', display_name: 'Old Editor', email: 'old@breeze.test' },
      ],
    })
    expect(
      await listDocumentCoAuthors(admin, {
        workspaceId: 'ws-1',
        documentIds: ['doc-1', 'doc-2'],
        fallbackSince: ago(1800),
      }),
    ).toEqual([
      { name: 'Ada Lovelace', email: 'ada@breeze.test' },
      { name: 'grace@breeze.test', email: 'grace@breeze.test' },
    ])
  })
})
