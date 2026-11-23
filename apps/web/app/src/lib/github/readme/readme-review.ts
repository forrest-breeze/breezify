import type { GitHubComparison, GitHubPR } from '../github'

/**
 * The review of a working branch: what it changes on the version it was cut
 * from, who changed it and when, and where its pull request stands.
 *
 * Built from the branch's pull request and GitHub's comparison of the branch
 * with the synced branch. Pure: no database or network access.
 */

export const README_REVIEW_MAX_FILES = 100
/** Total diff text sent to the browser; files past it keep their counts only. */
export const README_REVIEW_MAX_PATCH_BYTES = 400_000

export type ReadmeReviewFileStatus = 'added' | 'modified' | 'removed' | 'renamed'

export interface ReadmeReviewFile {
  path: string
  previousPath: string | null
  status: ReadmeReviewFileStatus
  additions: number
  deletions: number
  /** Unified diff; null when GitHub has none or it was left out for size. */
  patch: string | null
}

export interface ReadmeReviewCommit {
  sha: string
  url: string | null
  /** First line of the commit message. */
  subject: string
  author: string
  date: string | null
}

export interface ReadmeReviewContributor {
  name: string
  login: string | null
  avatarUrl: string | null
  /** When they last changed the branch. */
  lastActiveAt: string | null
}

export interface ReadmeBranchReview {
  branch: string
  base: string
  repoFullName: string
  pullRequest: {
    number: number
    url: string | null
    title: string
    draft: boolean
    createdAt: string
    updatedAt: string
  }
  /** Commits on the synced branch the working branch does not have yet. */
  behindBy: number
  commits: ReadmeReviewCommit[]
  contributors: ReadmeReviewContributor[]
  files: ReadmeReviewFile[]
  fileCount: number
  additions: number
  deletions: number
  /** True when files or diff text were left out for size. */
  truncated: boolean
}

function fileStatus(status: string): ReadmeReviewFileStatus {
  if (status === 'added' || status === 'removed' || status === 'renamed') return status
  return 'modified'
}

/** People credited with a `Co-authored-by` trailer. */
function coAuthors(message: string): Array<{ name: string; email: string }> {
  return [...message.matchAll(/^Co-authored-by:\s*(.+?)\s*<([^<>\s]+)>\s*$/gim)].map((match) => ({
    name: match[1]!.trim(),
    email: match[2]!.trim(),
  }))
}

export function buildReadmeBranchReview(input: {
  branch: string
  base: string
  repoFullName: string
  pullRequest: GitHubPR
  comparison: GitHubComparison
}): ReadmeBranchReview {
  const { comparison, pullRequest } = input

  const commits: ReadmeReviewCommit[] = comparison.commits.map((entry) => ({
    sha: entry.sha,
    url: entry.html_url ?? null,
    subject: entry.commit.message.split('\n')[0]!.trim(),
    author: entry.commit.author?.name?.trim() || entry.author?.login || 'Unknown',
    date: entry.commit.author?.date ?? null,
  }))

  // Breezify commits as its GitHub App and credits editors with trailers, so
  // the people behind a commit are its co-authors when it names any.
  const byKey = new Map<string, ReadmeReviewContributor>()
  const credit = (key: string, contributor: ReadmeReviewContributor): void => {
    const known = byKey.get(key)
    if (!known) {
      byKey.set(key, contributor)
      return
    }
    const newer =
      (contributor.lastActiveAt ? Date.parse(contributor.lastActiveAt) : 0) >
      (known.lastActiveAt ? Date.parse(known.lastActiveAt) : 0)
    if (newer) known.lastActiveAt = contributor.lastActiveAt
    known.login ??= contributor.login
    known.avatarUrl ??= contributor.avatarUrl
  }
  for (const entry of comparison.commits) {
    const date = entry.commit.author?.date ?? null
    const credited = coAuthors(entry.commit.message)
    if (credited.length > 0) {
      for (const person of credited) {
        credit(`email:${person.email.toLowerCase()}`, {
          name: person.name,
          login: null,
          avatarUrl: null,
          lastActiveAt: date,
        })
      }
      continue
    }
    const login = entry.author?.login ?? null
    const name = entry.commit.author?.name?.trim() || login || 'Unknown'
    credit(login ? `login:${login.toLowerCase()}` : `name:${name.toLowerCase()}`, {
      name,
      login,
      avatarUrl: entry.author?.avatar_url ?? null,
      lastActiveAt: date,
    })
  }
  const contributors = [...byKey.values()].sort(
    (a, b) =>
      (b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0) -
        (a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0) || a.name.localeCompare(b.name),
  )

  const changed = comparison.files ?? []
  let patchBytes = 0
  let truncated = changed.length > README_REVIEW_MAX_FILES
  const files: ReadmeReviewFile[] = changed.slice(0, README_REVIEW_MAX_FILES).map((file) => {
    let patch = file.patch ?? null
    if (patch !== null) {
      patchBytes += Buffer.byteLength(patch, 'utf8')
      if (patchBytes > README_REVIEW_MAX_PATCH_BYTES) {
        patch = null
        truncated = true
      }
    }
    return {
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: fileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      patch,
    }
  })

  return {
    branch: input.branch,
    base: input.base,
    repoFullName: input.repoFullName,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.html_url ?? null,
      title: pullRequest.title,
      draft: pullRequest.draft === true,
      createdAt: pullRequest.created_at,
      updatedAt: pullRequest.updated_at,
    },
    behindBy: comparison.behind_by,
    commits,
    contributors,
    files,
    fileCount: changed.length,
    additions: changed.reduce((total, file) => total + file.additions, 0),
    deletions: changed.reduce((total, file) => total + file.deletions, 0),
    truncated,
  }
}
