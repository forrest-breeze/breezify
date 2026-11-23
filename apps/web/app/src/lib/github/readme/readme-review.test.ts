import { describe, expect, it } from 'vitest'
import type { GitHubComparison, GitHubPR } from '../github'
import { isReadmePublishBranch, isValidReadmeBranchName } from './readme-publish'
import {
  buildReadmeBranchReview,
  README_REVIEW_MAX_FILES,
  README_REVIEW_MAX_PATCH_BYTES,
} from './readme-review'

const PULL_REQUEST: GitHubPR = {
  number: 12,
  html_url: 'https://github.test/example-org/docs/pull/12',
  title: 'docs: v1.6_pricing',
  body: null,
  state: 'open',
  merged: false,
  draft: true,
  head: { ref: 'v1.6_pricing', sha: 'head' },
  base: { ref: 'v1.6' },
  user: { login: 'breezify-bot[bot]', type: 'Bot' },
  created_at: '2026-11-20T10:00:00Z',
  updated_at: '2026-11-20T11:00:00Z',
}

function commit(input: {
  sha: string
  message: string
  name: string
  date: string
  login?: string
}): GitHubComparison['commits'][number] {
  return {
    sha: input.sha,
    html_url: `https://github.test/example-org/docs/commit/${input.sha}`,
    commit: { message: input.message, author: { name: input.name, date: input.date } },
    author: input.login ? { login: input.login, type: 'User', avatar_url: `https://avatars.test/${input.login}` } : null,
  }
}

function comparison(overrides: Partial<GitHubComparison> = {}): GitHubComparison {
  return {
    status: 'ahead',
    ahead_by: 2,
    behind_by: 1,
    total_commits: 2,
    commits: [
      commit({
        sha: 'a1',
        message:
          'docs: update docs/pricing.md from Breezify\n\nCo-authored-by: Ada Example <ada@example.com>',
        name: 'breezify-bot[bot]',
        login: 'breezify-bot[bot]',
        date: '2026-11-20T10:00:00Z',
      }),
      commit({
        sha: 'b2',
        message:
          'docs: sync 2 files from Breezify\n\n- docs/pricing.md\n- docs/fees.md\n\nCo-authored-by: Ada Example <ADA@example.com>\nCo-authored-by: Sam Example <sam@example.com>',
        name: 'breezify-bot[bot]',
        login: 'breezify-bot[bot]',
        date: '2026-11-20T11:00:00Z',
      }),
    ],
    files: [
      { filename: 'docs/pricing.md', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-old\n+new\n+line' },
      { filename: 'docs/fees.md', status: 'added', additions: 3, deletions: 0, patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c' },
      { filename: 'docs/costs.md', previous_filename: 'docs/cost.md', status: 'renamed', additions: 0, deletions: 0 },
    ],
    ...overrides,
  }
}

const build = (value: GitHubComparison) =>
  buildReadmeBranchReview({
    branch: 'v1.6_pricing',
    base: 'v1.6',
    repoFullName: 'example-org/docs',
    pullRequest: PULL_REQUEST,
    comparison: value,
  })

describe('buildReadmeBranchReview', () => {
  it('describes what the branch changes and where its pull request stands', () => {
    const review = build(comparison())
    expect(review).toMatchObject({
      branch: 'v1.6_pricing',
      base: 'v1.6',
      pullRequest: { number: 12, draft: true, url: 'https://github.test/example-org/docs/pull/12' },
      behindBy: 1,
      fileCount: 3,
      additions: 5,
      deletions: 1,
      truncated: false,
    })
    expect(review.files).toEqual([
      expect.objectContaining({ path: 'docs/pricing.md', status: 'modified', additions: 2, deletions: 1 }),
      expect.objectContaining({ path: 'docs/fees.md', status: 'added' }),
      { path: 'docs/costs.md', previousPath: 'docs/cost.md', status: 'renamed', additions: 0, deletions: 0, patch: null },
    ])
    expect(review.commits.map((entry) => entry.subject)).toEqual([
      'docs: update docs/pricing.md from Breezify',
      'docs: sync 2 files from Breezify',
    ])
  })

  it('credits the people named on a commit, not the app that made it', () => {
    expect(build(comparison()).contributors).toEqual([
      // Most recent first; the same person under two spellings of an email is one.
      { name: 'Ada Example', login: null, avatarUrl: null, lastActiveAt: '2026-11-20T11:00:00Z' },
      { name: 'Sam Example', login: null, avatarUrl: null, lastActiveAt: '2026-11-20T11:00:00Z' },
    ])
  })

  it('falls back to the commit author when a commit credits nobody', () => {
    const review = build(
      comparison({
        commits: [
          commit({ sha: 'c3', message: 'docs: fix typo', name: 'Sam Example', login: 'sam', date: '2026-11-20T09:00:00Z' }),
        ],
      }),
    )
    expect(review.contributors).toEqual([
      { name: 'Sam Example', login: 'sam', avatarUrl: 'https://avatars.test/sam', lastActiveAt: '2026-11-20T09:00:00Z' },
    ])
  })

  it('leaves diff text out past the size limit and says so', () => {
    const big = 'x'.repeat(README_REVIEW_MAX_PATCH_BYTES - 10)
    const review = build(
      comparison({
        files: [
          { filename: 'docs/a.md', status: 'modified', additions: 1, deletions: 1, patch: big },
          { filename: 'docs/b.md', status: 'modified', additions: 4, deletions: 2, patch: 'y'.repeat(100) },
        ],
      }),
    )
    expect(review.files[0]!.patch).toBe(big)
    expect(review.files[1]).toMatchObject({ patch: null, additions: 4, deletions: 2 })
    expect(review.truncated).toBe(true)

    const many = build(
      comparison({
        files: Array.from({ length: README_REVIEW_MAX_FILES + 5 }, (_unused, index) => ({
          filename: `docs/page-${index}.md`,
          status: 'modified',
          additions: 1,
          deletions: 0,
        })),
      }),
    )
    expect(many.files).toHaveLength(README_REVIEW_MAX_FILES)
    expect(many).toMatchObject({ fileCount: README_REVIEW_MAX_FILES + 5, truncated: true })
  })
})

describe('isReadmePublishBranch', () => {
  it('knows a working branch from the other format\'s publish branch', () => {
    expect(isReadmePublishBranch('breezify/readme-sync-abc')).toBe(true)
    expect(isReadmePublishBranch('v1.6_pricing')).toBe(true)
    expect(isReadmePublishBranch('breezify/docs-docs-workspace-abc')).toBe(false)
    expect(isReadmePublishBranch(null)).toBe(false)
    expect(isReadmePublishBranch('  ')).toBe(false)
  })
})

describe('isValidReadmeBranchName', () => {
  it('accepts the names docs branches use', () => {
    for (const name of ['v1.6_pricing', 'v1.6/pricing-phases', 'fix-typo']) {
      expect(isValidReadmeBranchName(name), name).toBe(true)
    }
  })

  it('rejects what Git or a URL would not take', () => {
    for (const name of [
      '',
      'has space',
      '-leading-dash',
      '.hidden',
      'trailing/',
      'trailing.',
      'double//slash',
      'dot..dot',
      'part/.hidden',
      'name.lock',
      'a~b',
      'a:b',
      // Breezify's own namespace.
      'breezify/readme-sync-abc',
      'Breezify/mine',
      'x'.repeat(201),
    ]) {
      expect(isValidReadmeBranchName(name), name).toBe(false)
    }
  })
})
