import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceSettings } from '@/lib/workspace-settings'
import {
  DEFAULT_DOCS_CHECKS,
  DEFAULT_GITHUB_PUBLISHING,
  getDocsChecksSettings,
  getGithubPublishingSettings,
  storedDocsChecks,
  storedGithubPublishing,
} from './docs-automation-settings'

describe('docs automation settings', () => {
  it('is entirely off until a workspace turns something on', () => {
    for (const settings of [undefined, null, {}, { github_publishing: 'yes', docs_checks: [] }]) {
      expect(getGithubPublishingSettings(settings)).toEqual(DEFAULT_GITHUB_PUBLISHING)
      expect(getDocsChecksSettings(settings)).toEqual(DEFAULT_DOCS_CHECKS)
    }
    expect(DEFAULT_GITHUB_PUBLISHING).toEqual({
      mergeMethod: 'merge',
      autoPublish: false,
      draftPullRequests: false,
      coAuthors: false,
    })
    expect(DEFAULT_DOCS_CHECKS).toEqual({ brokenLinks: 'disabled' })
  })

  it('round-trips through the stored shape', () => {
    const publishing = {
      mergeMethod: 'squash' as const,
      autoPublish: true,
      draftPullRequests: true,
      coAuthors: true,
    }
    const checks = { brokenLinks: 'blocking' as const }
    const settings = {
      github_publishing: storedGithubPublishing(publishing),
      docs_checks: storedDocsChecks(checks),
    }
    expect(getGithubPublishingSettings(settings)).toEqual(publishing)
    expect(getDocsChecksSettings(settings)).toEqual(checks)
  })

  it('falls back to safe values for anything it does not recognise', () => {
    const settings = {
      github_publishing: { merge_method: 'force-push', auto_publish: 'true', co_authors: 1 },
      docs_checks: { broken_links: 'fatal' },
    }
    expect(getGithubPublishingSettings(settings)).toEqual(DEFAULT_GITHUB_PUBLISHING)
    expect(getDocsChecksSettings(settings)).toEqual(DEFAULT_DOCS_CHECKS)
  })

  it('is canonicalized when workspace settings are saved, and left absent when unset', () => {
    const saved = normalizeWorkspaceSettings({
      github_publishing: { merge_method: 'rebase', auto_publish: true, junk: 1 },
      docs_checks: { broken_links: 'warning', extra: true },
    }) as Record<string, unknown>
    expect(saved.github_publishing).toEqual({
      merge_method: 'rebase',
      auto_publish: true,
      draft_pull_requests: false,
      co_authors: false,
    })
    expect(saved.docs_checks).toEqual({ broken_links: 'warning' })
    const untouched = normalizeWorkspaceSettings({}) as Record<string, unknown>
    expect(untouched).not.toHaveProperty('github_publishing')
    expect(untouched).not.toHaveProperty('docs_checks')
  })
})
