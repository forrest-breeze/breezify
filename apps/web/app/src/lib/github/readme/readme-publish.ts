import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import {
  createRepositoryBranch,
  createRepositoryFilesCommit,
  createRepositoryPullRequest,
  findOpenRepositoryPullRequest,
  getInstallationToken,
  getRepository,
  getRepositoryBlob,
  getRepositoryBranchReference,
  getRepositoryCommit,
  getRepositoryTree,
  type GitHubRepositoryCommit,
} from '../github'
import { GitHubApiError, withGitHubRetry } from '../retry'
import {
  planReadmeExport,
  ReadmeExportSelectionError,
  selectReadmeExportPlan,
  type ReadmeExportDocument,
  type ReadmeExportFolder,
  type ReadmeExportPlan,
  type ReadmeExportSpec,
} from './readme-export'
import { readmeFolderListing } from './readme-folder-visibility'
import {
  isApiReferencePage,
  readmeFolderMetadata,
  readmeSectionOf,
  README_MAX_PAGE_BYTES,
  readReadmeDocumentLink,
  readReadmeFolderLink,
  readReadmeSyncState,
  relativeReadmePath,
  type ReadmeSyncState,
} from './readme-layout'
import { BREEZIFY_BRANCH_NAMESPACE, isValidReadmeBranchName } from './readme-branch-name'
import { canonicalReadmeMarkdown } from './readme-preserve'
import { parseSpecDocument } from './readme-sync'
import type { ReadmeStore, ReadmeStoreDocument } from './readme-store'

/**
 * Workspace -> repository, for the ReadMe format.
 *
 * `direct` commits straight to the synced branch, which is how ReadMe's own
 * GitHub integration behaves. `pull_request` collects the same changes on a
 * Breezify-owned branch for repositories whose branch is protected.
 */

export type ReadmePublishMode = 'direct' | 'pull_request'

export interface ReadmePublishSource {
  installationId: number
  repoId: number
  repoFullName: string
  root: string
  branch: string | null
  lastSyncCommitSha: string | null
  syncState: unknown
  publishMode: ReadmePublishMode
  publishPullRequestNumber: number | null
  publishPullRequestHead: string | null
  /** Open a new publish pull request as a draft. */
  draftPullRequests?: boolean
}

/** Someone credited on a commit with a `Co-authored-by` trailer. */
export interface CommitCoAuthor {
  name: string
  email: string
}

export interface ReadmePublishDeps {
  store: ReadmeStore
  toMarkdown: (content: string | null | undefined) => string
  getToken?: typeof getInstallationToken
  getRepo?: typeof getRepository
  getCommit?: typeof getRepositoryCommit
  getTree?: typeof getRepositoryTree
  getBlob?: typeof getRepositoryBlob
  getBranchReference?: typeof getRepositoryBranchReference
  createBranch?: typeof createRepositoryBranch
  createFilesCommit?: typeof createRepositoryFilesCommit
  createPullRequest?: typeof createRepositoryPullRequest
  findOpenPullRequest?: typeof findOpenRepositoryPullRequest
  retry?: <T>(operation: () => Promise<T>) => Promise<T>
  now?: () => number
}

export class ReadmePublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ReadmePublishError'
  }
}

export const README_PUBLISH_BRANCH_PREFIX = 'breezify/readme-sync-'
export const README_DIFF_MAX_FILES = 60
export const README_DIFF_MAX_BYTES = 256_000
/** Repository files read at once to keep the unedited source of edited pages. */
const SOURCE_READ_CONCURRENCY = 6

/**
 * Whether a recorded publish branch is this format's working branch: one
 * Breezify created to hold workspace changes, named by Breezify
 * (`breezify/readme-sync-...`) or by the person who saved to it
 * (`v1.6_pricing`). Anything else under `breezify/` belongs to the other
 * repository format, whose pointer a link can still carry.
 */
export function isReadmePublishBranch(head: string | null | undefined): boolean {
  const name = head?.trim()
  if (!name) return false
  return name.startsWith(README_PUBLISH_BRANCH_PREFIX) || !name.startsWith(BREEZIFY_BRANCH_NAMESPACE)
}

export { isValidReadmeBranchName }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** The spec in the format its repository file uses (JSON or YAML). */
export function specFileContent(raw: string, repoPath: string | null): string {
  if (!repoPath) return raw
  const rawIsJson = /^\s*[{[]/.test(raw)
  const fileIsJson = /\.json$/i.test(repoPath)
  if (rawIsJson === fileIsJson) return raw
  const parsed = parseSpecDocument(raw)
  if (!parsed) return raw
  return fileIsJson
    ? `${JSON.stringify(parsed, null, 2)}\n`
    : yaml.dump(parsed, { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true })
}

export async function loadReadmeExportInput(
  store: ReadmeStore,
  repoId: number,
  toMarkdown: (content: string | null | undefined) => string,
): Promise<{
  folders: ReadmeExportFolder[]
  documents: ReadmeExportDocument[]
  specs: ReadmeExportSpec[]
  storeDocuments: ReadmeStoreDocument[]
  /**
   * API reference pages that are not generated from a definition: imported or
   * written by hand. The sync never writes or reads them, so GitHub can be "up
   * to date" while they differ from the repository's definition.
   */
  unsyncedApiReferencePageCount: number
}> {
  const [folders, documents, specs] = await Promise.all([
    store.listFolders(),
    store.listDocuments(),
    store.listSpecs(),
  ])
  // Role-restricted folders stay in Breezify: nothing under them is written to
  // GitHub. The exception is a folder that mirrors a repository directory,
  // whose content is in the repository already.
  const exported = folders.filter(
    (folder) => !folder.restricted || readReadmeFolderLink(folder.metadata, repoId) !== null,
  )
  // API reference pages are generated from a definition; the definition is
  // what goes to GitHub, the same way the sync leaves reference stubs alone.
  const mirrored = documents.filter((document) => !isApiReferencePage(document.metadata))
  const restrictedIds = new Set(
    folders.filter((folder) => folder.restricted).map((folder) => folder.id),
  )
  const unsyncedApiReferencePageCount = documents.filter(
    (document) =>
      isApiReferencePage(document.metadata) &&
      !(document.folderId !== null && restrictedIds.has(document.folderId)),
  ).length
  return {
    storeDocuments: documents,
    unsyncedApiReferencePageCount,
    folders: exported.map((folder) => ({
      id: folder.id,
      displayName: folder.displayName,
      parentId: folder.parentId,
      sortOrder: folder.sortOrder,
      markdown: toMarkdown(folder.content),
      link: readReadmeFolderLink(folder.metadata, repoId),
      // A folder that is not public is left out of the order file, which is
      // what keeps a directory off the site built from the repository.
      listing: readmeFolderListing({
        restricted: folder.restricted,
        parentRestricted: folder.parentId !== null && restrictedIds.has(folder.parentId),
        sortOrder: folder.sortOrder,
        metadata: folder.metadata,
      }),
    })),
    documents: mirrored.map((document) => {
      const metadata = document.metadata
      const sameRepository = Number(metadata?.repo_id) === repoId
      const pending = metadata?.github_hosted_pending_path
      const previous = metadata?.canonical_repo_path
      return {
        id: document.id,
        title: document.title.trim() || 'Untitled',
        hidden: document.status !== 'Published',
        folderId: document.folderId,
        sortOrder: document.sortOrder,
        publicSlug: document.publicSlug,
        markdown: toMarkdown(document.content),
        publishedDate:
          typeof metadata?.published_date === 'string' ? metadata.published_date : null,
        link: readReadmeDocumentLink(metadata, repoId),
        preferredPath: !sameRepository
          ? null
          : typeof pending === 'string'
            ? pending
            : typeof previous === 'string'
              ? previous
              : null,
      }
    }),
    specs: specs
      .filter((spec) => spec.specRaw)
      .map((spec) => ({
        slug: spec.slug,
        raw: specFileContent(spec.specRaw!, spec.repoPath),
        repoPath: spec.repoPath,
      })),
  }
}

interface Comparison {
  token: string
  branch: string
  head: GitHubRepositoryCommit
  /** Commit and tree the plan is computed against and committed onto. */
  base: GitHubRepositoryCommit
  tree: Map<string, string>
  sizes: Map<string, number>
  /** Open publish pull request this plan would extend. */
  pullRequest: { number: number; url: string; branch: string } | null
  plan: ReadmeExportPlan
  storeDocuments: ReadmeStoreDocument[]
  unsyncedApiReferencePageCount: number
  state: ReadmeSyncState
}

function resolveDeps(deps: ReadmePublishDeps) {
  return {
    getToken: deps.getToken ?? getInstallationToken,
    getRepo: deps.getRepo ?? getRepository,
    getCommit: deps.getCommit ?? getRepositoryCommit,
    getTree: deps.getTree ?? getRepositoryTree,
    getBlob: deps.getBlob ?? getRepositoryBlob,
    getBranchReference: deps.getBranchReference ?? getRepositoryBranchReference,
    createBranch: deps.createBranch ?? createRepositoryBranch,
    createFilesCommit: deps.createFilesCommit ?? createRepositoryFilesCommit,
    createPullRequest: deps.createPullRequest ?? createRepositoryPullRequest,
    findOpenPullRequest: deps.findOpenPullRequest ?? findOpenRepositoryPullRequest,
    retry: deps.retry ?? withGitHubRetry,
    now: deps.now ?? Date.now,
  }
}

async function resolveComparison(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
  options: { includeConflicts?: boolean; selectedPaths?: string[] } = {},
): Promise<Comparison> {
  const github = resolveDeps(deps)
  const { retry } = github
  const token = await retry(() => github.getToken(source.installationId))
  const repository = await retry(() => github.getRepo(token, source.repoFullName))
  if (repository.id !== source.repoId) {
    throw new ReadmePublishError(
      'The configured GitHub repository no longer matches this workspace link.',
      409,
      'repository_mismatch',
    )
  }
  const branch = source.branch ?? repository.default_branch
  const head = await retry(() => github.getCommit(token, source.repoFullName, branch))
  if (!source.lastSyncCommitSha || source.lastSyncCommitSha !== head.sha) {
    throw new ReadmePublishError(
      'GitHub has changes that Breezify has not synchronized yet. Sync before publishing.',
      409,
      'github_sync_required',
      {
        last_synced_commit_sha: source.lastSyncCommitSha,
        current_commit_sha: head.sha,
      },
    )
  }
  const headTree = await retry(() =>
    github.getTree(token, source.repoFullName, head.commit.tree.sha),
  )
  if (headTree.truncated) {
    throw new ReadmePublishError(
      'The repository file tree is too large to publish safely.',
      409,
      'repository_tree_truncated',
    )
  }

  let base = head
  let baseTree = headTree
  let pullRequest: Comparison['pullRequest'] = null
  const state = readReadmeSyncState(source.syncState, source.root)
  let managedPaths = state.managed_paths
  // An open working branch is where changes go next, whichever way this link
  // publishes otherwise.
  if (isReadmePublishBranch(source.publishPullRequestHead)) {
    const prBranch = source.publishPullRequestHead!
    const [open, reference] = await Promise.all([
      retry(() =>
        github.findOpenPullRequest(token, source.repoFullName, { head: prBranch, base: branch }),
      ),
      retry(() => github.getBranchReference(token, source.repoFullName, prBranch)),
    ])
    if (open && reference) {
      pullRequest = { number: open.number, url: open.html_url, branch: prBranch }
      if (reference.object.sha !== head.sha) {
        base = await retry(() =>
          github.getCommit(token, source.repoFullName, reference.object.sha),
        )
        baseTree = await retry(() =>
          github.getTree(token, source.repoFullName, base.commit.tree.sha),
        )
        // Files an earlier publish added on this branch are Breezify's to remove.
        const onBranchOnly = baseTree.tree.filter(
          (entry) =>
            entry.type === 'blob' &&
            !headTree.tree.some((other) => other.path === entry.path) &&
            readmeSectionOf(relativeReadmePath(source.root, entry.path) ?? '') !== null,
        )
        managedPaths = [...managedPaths, ...onBranchOnly.map((entry) => entry.path)]
      }
    }
  }

  const tree = new Map<string, string>()
  const sizes = new Map<string, number>()
  for (const entry of baseTree.tree) {
    if (entry.type !== 'blob') continue
    tree.set(entry.path, entry.sha)
    sizes.set(entry.path, entry.size ?? 0)
  }
  const exported = await loadReadmeExportInput(deps.store, source.repoId, deps.toMarkdown)
  const planInput: Parameters<typeof planReadmeExport>[0] = {
    root: source.root,
    folders: exported.folders,
    documents: exported.documents,
    specs: exported.specs,
    tree,
    state: { ...state, managed_paths: managedPaths },
    includeConflicts: options.includeConflicts,
    canonical: (markdown) => canonicalReadmeMarkdown(markdown, deps.toMarkdown),
  }
  let complete = planReadmeExport(planInput)
  if (complete.sourcePaths.length > 0) {
    // Pages edited in Breezify: read their files so only what was edited is
    // rewritten. A file that cannot be read is written whole, as before.
    const previousContent = new Map<string, string>()
    const readable = complete.sourcePaths.filter(
      (path) => (sizes.get(path) ?? 0) <= README_MAX_PAGE_BYTES,
    )
    for (let start = 0; start < readable.length; start += SOURCE_READ_CONCURRENCY) {
      await Promise.all(
        readable.slice(start, start + SOURCE_READ_CONCURRENCY).map(async (path) => {
          try {
            const blob = await retry(() =>
              github.getBlob(token, source.repoFullName, tree.get(path)!),
            )
            previousContent.set(path, Buffer.from(blob.content, 'base64').toString('utf8'))
          } catch {
            // Left out: the page is written whole.
          }
        }),
      )
    }
    complete = planReadmeExport({ ...planInput, previousContent })
  }
  let plan: ReadmeExportPlan
  try {
    plan = selectReadmeExportPlan(complete, options.selectedPaths)
  } catch (error) {
    if (!(error instanceof ReadmeExportSelectionError)) throw error
    throw new ReadmePublishError(
      'The selected files no longer match the current GitHub comparison. Refresh the Changes view and try again.',
      409,
      'selected_paths_changed',
      { paths: error.paths },
    )
  }
  return {
    token,
    branch,
    head,
    base,
    tree,
    sizes,
    pullRequest,
    plan,
    storeDocuments: exported.storeDocuments,
    unsyncedApiReferencePageCount: exported.unsyncedApiReferencePageCount,
    state,
  }
}

export interface ReadmePublishInspection {
  status: 'up_to_date' | 'changes' | 'sync_required' | 'blocked'
  changedFileCount: number
  writtenFileCount: number
  deletedFileCount: number
  unchangedFileCount: number
  conflictCount: number
  /** See loadReadmeExportInput. Reported so "up to date" is not misleading. */
  unsyncedApiReferencePageCount: number
  comparedCommitSha: string | null
  comparisonKey: string | null
  pullRequestUpToDate?: boolean
  code?: string
  message?: string
}

function comparisonKey(plan: ReadmeExportPlan, commitSha: string): string {
  const hash = createHash('sha256').update(commitSha)
  for (const write of plan.writes) {
    hash.update('\0write\0').update(write.path).update('\0').update(sha256(write.content))
  }
  for (const path of plan.deletes) hash.update('\0delete\0').update(path)
  return hash.digest('hex')
}

export async function inspectReadmePublish(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
): Promise<ReadmePublishInspection> {
  try {
    const comparison = await resolveComparison(source, deps)
    const { plan } = comparison
    const changed = plan.writes.length + plan.deletes.length
    return {
      status: changed === 0 ? 'up_to_date' : 'changes',
      changedFileCount: changed,
      writtenFileCount: plan.writes.length,
      deletedFileCount: plan.deletes.length,
      unchangedFileCount: plan.unchangedCount,
      conflictCount: plan.conflictCount,
      unsyncedApiReferencePageCount: comparison.unsyncedApiReferencePageCount,
      comparedCommitSha: comparison.base.sha,
      comparisonKey: comparisonKey(plan, comparison.base.sha),
      pullRequestUpToDate: comparison.pullRequest ? changed === 0 : undefined,
    }
  } catch (error) {
    if (!(error instanceof ReadmePublishError)) throw error
    const current = error.details.current_commit_sha
    return {
      status: error.code === 'github_sync_required' ? 'sync_required' : 'blocked',
      changedFileCount: 0,
      writtenFileCount: 0,
      deletedFileCount: 0,
      unchangedFileCount: 0,
      conflictCount: 0,
      unsyncedApiReferencePageCount: 0,
      comparedCommitSha: typeof current === 'string' ? current : null,
      comparisonKey: null,
      code: error.code,
      message: error.message,
    }
  }
}

export interface ReadmePublishDiffFile {
  path: string
  status: 'added' | 'modified' | 'removed'
  previous: string
  next: string
  bodyOmitted?: boolean
  previousBlobSha?: string
}

export async function diffReadmePublish(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
): Promise<{
  files: ReadmePublishDiffFile[]
  changedFileCount: number
  truncated: boolean
  comparedCommitSha: string
}> {
  const comparison = await resolveComparison(source, deps)
  const github = resolveDeps(deps)
  const { plan, tree, sizes, token } = comparison
  const files: ReadmePublishDiffFile[] = [
    ...plan.writes.map((write) => ({
      path: write.path,
      status: tree.has(write.path) ? ('modified' as const) : ('added' as const),
      previous: '',
      next: write.content,
      previousBlobSha: tree.get(write.path),
    })),
    ...plan.deletes.map((path) => ({
      path,
      status: 'removed' as const,
      previous: '',
      next: '',
      previousBlobSha: tree.get(path),
    })),
  ].sort((a, b) => a.path.localeCompare(b.path))
  const visible = files.slice(0, README_DIFF_MAX_FILES)
  await Promise.all(
    visible.map(async (file) => {
      if (file.status === 'added' || !file.previousBlobSha) return
      if ((sizes.get(file.path) ?? 0) > README_DIFF_MAX_BYTES) {
        file.bodyOmitted = true
        return
      }
      try {
        const blob = await github.retry(() =>
          github.getBlob(token, source.repoFullName, file.previousBlobSha!),
        )
        file.previous = Buffer.from(blob.content, 'base64').toString('utf8')
      } catch {
        file.bodyOmitted = true
      }
    }),
  )
  return {
    files: visible,
    changedFileCount: files.length,
    truncated: files.length > visible.length,
    comparedCommitSha: comparison.base.sha,
  }
}

export interface ReadmePublishResult {
  mode: ReadmePublishMode
  branch: string
  commitSha: string
  commitUrl: string
  pullRequestNumber: number | null
  pullRequestUrl: string | null
  changedFileCount: number
  writtenFileCount: number
  deletedFileCount: number
}

/**
 * `Co-authored-by` trailers, one per person. Names and emails come from
 * profiles, so anything that could break out of the trailer line is dropped.
 */
export function coAuthorTrailers(coAuthors: readonly CommitCoAuthor[]): string[] {
  const seen = new Set<string>()
  const trailers: string[] = []
  for (const coAuthor of coAuthors) {
    const email = coAuthor.email.trim()
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const name =
      coAuthor.name.replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim() || email.split('@')[0]!
    trailers.push(`Co-authored-by: ${name} <${email}>`)
  }
  return trailers
}

function commitMessage(plan: ReadmeExportPlan, message: string | undefined): string {
  const paths = [...plan.writes.map((write) => write.path), ...plan.deletes]
  const subject =
    message?.trim().split('\n')[0]?.slice(0, 120) ||
    (paths.length === 1
      ? `docs: update ${paths[0]} from Breezify`
      : `docs: sync ${paths.length} files from Breezify`)
  const listed = [
    ...plan.writes.slice(0, 20).map((write) => `- ${write.path}`),
    ...plan.deletes.slice(0, 20).map((path) => `- ${path} (removed)`),
  ]
  return paths.length > 1 ? `${subject}\n\n${listed.join('\n')}` : subject
}

function mapCommitError(error: unknown, branch: string): never {
  if (error instanceof GitHubApiError) {
    const text = error.message
    if (/protected|rule violations|GH006|GH013|required status|pull request is required/i.test(text)) {
      throw new ReadmePublishError(
        `GitHub rejected the push: ${branch} is protected. Allow the Breezify GitHub App to bypass the branch rules, or switch publishing to pull requests in Settings.`,
        409,
        'branch_protected',
        { branch },
      )
    }
    if (error.status === 422 && /fast.?forward/i.test(text)) {
      throw new ReadmePublishError(
        'GitHub received new commits while publishing. Sync and try again.',
        409,
        'github_sync_required',
      )
    }
    if (error.status === 403 || error.status === 404) {
      throw new ReadmePublishError(
        'The Breezify GitHub App cannot write to this repository. It needs read and write access to Contents.',
        409,
        'github_write_denied',
      )
    }
  }
  throw error
}

/** Record that the workspace now matches what was just committed. */
async function recordPublishedPlan(
  store: ReadmeStore,
  input: {
    source: ReadmePublishSource
    comparison: Comparison
    commitSha: string
  },
): Promise<void> {
  const { source, comparison, commitSha } = input
  const { plan, storeDocuments, state, branch } = comparison
  const documentById = new Map(storeDocuments.map((document) => [document.id, document]))

  // A page may be written to a path a trashed document used to have.
  await store.releaseDeletedPaths(plan.documents.map((result) => result.path))
  for (const result of plan.documents) {
    const document = documentById.get(result.id)
    if (!document) continue
    await store.updateDocument(result.id, {
      metadata: {
        ...(document.metadata ?? {}),
        kind: 'github_hosted_document',
        repo_format: 'readme',
        canonical_repo_path: result.path,
        path: result.path,
        github_hosted_sync: true,
        github_hosted_conflict: false,
        github_hosted_pending_content_hash: null,
        github_hosted_pending_commit_sha: null,
        github_hosted_pending_path: null,
        github_hosted_detached_reason: null,
        github_hosted_content_hash: sha256(document.content),
        github_hosted_checkpoint_blob_sha: result.blobSha,
        readme_markdown_hash: result.markdownHash,
        readme_title: result.title,
        readme_hidden: result.hidden,
        readme_frontmatter: result.frontmatter,
        readme_frontmatter_raw: result.frontmatterRaw,
        readme_synced_at: new Date().toISOString(),
        repo_id: source.repoId,
        repo_full_name: source.repoFullName,
        ref: branch,
        commit_sha: commitSha,
      },
    })
  }
  const folders = await store.listFolders()
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  for (const result of plan.folders) {
    if (!result.linkChanged) continue
    const folder = folderById.get(result.id)
    if (!folder) continue
    await store.updateFolder(result.id, {
      metadata: {
        ...(folder.metadata ?? {}),
        ...readmeFolderMetadata(source.repoId, result.link),
      },
    })
  }
  for (const spec of plan.specs) {
    await store.setSpecRepository(spec.slug, { repoPath: spec.path, repoBlobSha: spec.blobSha })
  }
  if (plan.deletes.length > 0) await store.clearDeletedLinks(plan.deletes)

  const deleted = new Set(plan.deletes)
  const orderFiles = Object.fromEntries(
    Object.entries({ ...state.order_files, ...plan.orderFiles }).filter(
      ([path]) => !deleted.has(path),
    ),
  )
  const remaining = await store.listDocuments()
  const nextState: ReadmeSyncState = {
    ...state,
    order_files: orderFiles,
    managed_paths: plan.managedPaths,
  }
  await store.updateSource({
    sync_state: nextState,
    last_sync_commit_sha: commitSha,
    last_sync_at: new Date().toISOString(),
    conflict_count: remaining.filter(
      (document) =>
        Number(document.metadata?.repo_id) === source.repoId &&
        document.metadata?.github_hosted_conflict === true,
    ).length,
  })
}

export async function publishReadmeWorkspace(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
  options: {
    includeConflicts?: boolean
    selectedPaths?: string[]
    message?: string
    /**
     * Save to a new working branch with this name instead of publishing the
     * usual way. It is cut from the synced branch and opens as a draft pull
     * request; later publishes add to it until it is merged or closed.
     */
    branch?: string
    /**
     * People to credit on the commit, given the documents it writes. Looked up
     * only once there is something to commit.
     */
    coAuthors?: (documentIds: string[]) => Promise<CommitCoAuthor[]>
  } = {},
): Promise<ReadmePublishResult> {
  const github = resolveDeps(deps)
  const comparison = await resolveComparison(source, deps, options)
  const { plan, token, branch, base, head } = comparison
  const requestedBranch = options.branch?.trim() || null
  if (requestedBranch !== null) {
    if (!isValidReadmeBranchName(requestedBranch)) {
      throw new ReadmePublishError(
        'Use letters, numbers, dots, dashes, underscores and slashes for a branch name.',
        400,
        'invalid_branch_name',
      )
    }
    if (requestedBranch === branch) {
      throw new ReadmePublishError(
        `${branch} is the branch this workspace is synced with. Choose another name.`,
        409,
        'branch_is_synced',
      )
    }
    if (comparison.pullRequest && comparison.pullRequest.branch !== requestedBranch) {
      throw new ReadmePublishError(
        `Changes are already being saved to ${comparison.pullRequest.branch}. Merge or close it before starting another branch.`,
        409,
        'working_branch_open',
        { branch: comparison.pullRequest.branch },
      )
    }
  }
  const changed = plan.writes.length + plan.deletes.length
  if (changed === 0) {
    throw new ReadmePublishError(
      'GitHub already matches the Breezify workspace.',
      409,
      'no_changes',
    )
  }
  const trailers = options.coAuthors
    ? coAuthorTrailers(
        await options.coAuthors(
          plan.documents.filter((document) => document.written).map((document) => document.id),
        ),
      )
    : []
  const message =
    trailers.length > 0
      ? `${commitMessage(plan, options.message)}\n\n${trailers.join('\n')}`
      : commitMessage(plan, options.message)

  // A working branch, open or asked for, takes the changes instead of the
  // synced branch.
  const onWorkingBranch = comparison.pullRequest !== null || requestedBranch !== null
  if (source.publishMode === 'direct' && !onWorkingBranch) {
    const commit = await github
      .retry(() =>
        github.createFilesCommit(token, source.repoFullName, {
          branch,
          baseCommitSha: head.sha,
          baseTreeSha: head.commit.tree.sha,
          message,
          files: plan.writes,
          deletePaths: plan.deletes,
        }),
      )
      .catch((error: unknown) => mapCommitError(error, branch))
    await recordPublishedPlan(deps.store, { source, comparison, commitSha: commit.sha })
    return {
      mode: 'direct',
      branch,
      commitSha: commit.sha,
      commitUrl: commit.html_url,
      pullRequestNumber: null,
      pullRequestUrl: null,
      changedFileCount: changed,
      writtenFileCount: plan.writes.length,
      deletedFileCount: plan.deletes.length,
    }
  }

  const prBranch =
    comparison.pullRequest?.branch ??
    requestedBranch ??
    `${README_PUBLISH_BRANCH_PREFIX}${github.now().toString(36)}`
  if (!comparison.pullRequest) {
    if (requestedBranch !== null) {
      // Never adopt a branch someone else made: its commits are not Breezify's.
      const existing = await github.retry(() =>
        github.getBranchReference(token, source.repoFullName, requestedBranch),
      )
      if (existing) {
        throw new ReadmePublishError(
          `A branch named ${requestedBranch} already exists. Choose another name.`,
          409,
          'branch_exists',
          { branch: requestedBranch },
        )
      }
    }
    await github.retry(() =>
      github.createBranch(token, source.repoFullName, prBranch, head.sha),
    )
  }
  const commit = await github
    .retry(() =>
      github.createFilesCommit(token, source.repoFullName, {
        branch: prBranch,
        baseCommitSha: base.sha,
        baseTreeSha: base.commit.tree.sha,
        message,
        files: plan.writes,
        deletePaths: plan.deletes,
      }),
    )
    .catch((error: unknown) => mapCommitError(error, prBranch))
  const pullRequestArgs = {
    head: prBranch,
    base: branch,
    title: requestedBranch !== null ? `docs: ${requestedBranch}` : 'docs: sync from Breezify',
    body: [
      requestedBranch !== null
        ? `Changes saved to \`${requestedBranch}\` from the Breezify workspace.`
        : 'Publishes the current Breezify workspace to this repository.',
      '',
      `${plan.writes.length} file${plan.writes.length === 1 ? '' : 's'} written; ${plan.deletes.length} deleted.`,
      '',
      'Merge this pull request to make the changes live. Breezify picks the merge up automatically.',
    ].join('\n'),
  }
  // A branch someone chose to save to is work in progress until they ask
  // for a review.
  const wantDraft = source.draftPullRequests === true || requestedBranch !== null
  const createPullRequest = (draft: boolean) =>
    github.retry(() =>
      github.createPullRequest(token, source.repoFullName, {
        ...pullRequestArgs,
        ...(draft ? { draft: true } : {}),
      }),
    )
  const pullRequest: { number: number; url: string; branch: string } =
    comparison.pullRequest ??
    (await createPullRequest(wantDraft)
      .catch((error: unknown) => {
        // Some repositories (private ones on plans without drafts) reject a
        // draft outright. The publish still has to land, so open it normally.
        const draftUnsupported =
          wantDraft &&
          error instanceof GitHubApiError &&
          error.status === 422 &&
          /draft/i.test(error.message)
        if (!draftUnsupported) throw error
        return createPullRequest(false)
      })
      .then((created) => ({ number: created.number, url: created.html_url, branch: prBranch })))

  // Until the pull request merges nothing is linked. Remember where each new
  // document was written so the merge links it instead of importing a copy.
  const documentById = new Map(
    comparison.storeDocuments.map((document) => [document.id, document]),
  )
  for (const result of plan.documents) {
    const document = documentById.get(result.id)
    if (!document || readReadmeDocumentLink(document.metadata, source.repoId)) continue
    await deps.store.updateDocument(result.id, {
      metadata: {
        ...(document.metadata ?? {}),
        github_hosted_pending_path: result.path,
        repo_id: source.repoId,
      },
    })
  }
  await deps.store.updateSource({
    publish_pull_request_number: pullRequest.number,
    publish_pull_request_url: pullRequest.url,
    publish_pull_request_head: prBranch,
    publish_last_commit_sha: commit.sha,
  })
  return {
    mode: 'pull_request',
    branch: prBranch,
    commitSha: commit.sha,
    commitUrl: commit.html_url,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    changedFileCount: changed,
    writtenFileCount: plan.writes.length,
    deletedFileCount: plan.deletes.length,
  }
}

/**
 * Commit one OpenAPI definition to the synced branch right after it was
 * uploaded (CI or Settings), the way ReadMe writes an uploaded definition back
 * to the repository. Touches a single Breezify-owned path, so it does not need
 * the workspace to be fully synchronized first.
 */
export async function commitReadmeSpecFile(
  source: ReadmePublishSource,
  deps: ReadmePublishDeps,
  input: { slug: string; raw: string | null; repoPath: string | null },
): Promise<{ committed: boolean; path: string | null; commitSha: string | null }> {
  if (source.publishMode !== 'direct') return { committed: false, path: null, commitSha: null }
  const github = resolveDeps(deps)
  const { retry } = github
  const token = await retry(() => github.getToken(source.installationId))
  const repository = await retry(() => github.getRepo(token, source.repoFullName))
  if (repository.id !== source.repoId) return { committed: false, path: null, commitSha: null }
  const branch = source.branch ?? repository.default_branch
  const head = await retry(() => github.getCommit(token, source.repoFullName, branch))
  const tree = await retry(() => github.getTree(token, source.repoFullName, head.commit.tree.sha))
  const blobByPath = new Map(
    tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]),
  )

  const removing = input.raw === null
  const [planned] = planReadmeExport({
    root: source.root,
    folders: [],
    documents: [],
    specs: removing ? [] : [{
      slug: input.slug,
      raw: specFileContent(input.raw!, input.repoPath),
      repoPath: input.repoPath,
    }],
    tree: blobByPath,
    state: readReadmeSyncState(null, source.root),
  }).specs
  const path = removing ? input.repoPath : planned!.path
  if (!path) return { committed: false, path: null, commitSha: null }
  if (removing ? !blobByPath.has(path) : !planned!.written) {
    if (!removing) {
      await deps.store.setSpecRepository(input.slug, {
        repoPath: path,
        repoBlobSha: planned!.blobSha,
      })
    }
    return { committed: false, path, commitSha: null }
  }

  const commit = await retry(() =>
    github.createFilesCommit(token, source.repoFullName, {
      branch,
      baseCommitSha: head.sha,
      baseTreeSha: head.commit.tree.sha,
      message: removing
        ? `docs: remove OpenAPI definition ${input.slug}`
        : `docs: update OpenAPI definition ${input.slug}`,
      files: removing
        ? []
        : [{ path, content: specFileContent(input.raw!, input.repoPath) }],
      deletePaths: removing ? [path] : [],
    }),
  ).catch((error: unknown) => mapCommitError(error, branch))

  if (!removing) {
    await deps.store.setSpecRepository(input.slug, {
      repoPath: path,
      repoBlobSha: planned!.blobSha,
    })
  }
  // Only advance the sync checkpoint when nothing else was waiting to be
  // pulled; otherwise the push webhook reconciles the rest.
  if (source.lastSyncCommitSha === head.sha) {
    const state = readReadmeSyncState(source.syncState, source.root)
    const managed = new Set(state.managed_paths)
    if (removing) managed.delete(path)
    else managed.add(path)
    await deps.store.updateSource({
      last_sync_commit_sha: commit.sha,
      sync_state: { ...state, managed_paths: [...managed].sort((a, b) => a.localeCompare(b)) },
    })
  }
  return { committed: true, path, commitSha: commit.sha }
}
