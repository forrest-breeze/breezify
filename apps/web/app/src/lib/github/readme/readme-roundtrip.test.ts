import { describe, expect, it } from 'vitest'
import { FakeRepository, MemoryReadmeStore } from '@/test/readme-sync-fixtures'
import { parseOrderFile, parseReadmeFile } from './readme-frontmatter'
import {
  commitReadmeSpecFile,
  diffReadmePublish,
  inspectReadmePublish,
  publishReadmeWorkspace,
  ReadmePublishError,
  type ReadmePublishMode,
  type ReadmePublishSource,
} from './readme-publish'
import { syncReadmeRepository, type ReadmeSyncMode } from './readme-sync'

const PETSTORE_YAML = [
  'openapi: 3.0.3',
  'info:',
  '  title: Payments API',
  '  version: 1.0.0',
  'paths:',
  '  /payments:',
  '    get:',
  '      operationId: listPayments',
  '      responses:',
  "        '200':",
  '          description: OK',
  '',
].join('\n')

const QUICKSTART = [
  '---',
  'title: Quickstart',
  'excerpt: Take your first payment.',
  'hidden: false',
  'metadata:',
  '  title: Quickstart | Breeze',
  '  robots: index',
  'next:',
  '  pages:',
  '    - slug: api-keys',
  '      type: basic',
  '---',
  'Install the SDK.',
  '',
  '<Callout icon="📘" theme="info">',
  '  Sandbox keys start with `sk_test`.',
  '</Callout>',
  '',
].join('\n')

/** A repository laid out the way ReadMe's GitHub integration writes it. */
function readmeRepositoryFiles(): Record<string, string> {
  return {
    'README.md': '# not part of the docs\n',
    'docs/_order.yaml': '- getting-started\n- guides\n',
    'docs/getting-started/_order.yaml': '- quickstart\n- authentication\n',
    'docs/getting-started/quickstart.md': QUICKSTART,
    'docs/getting-started/authentication/index.md':
      '---\ntitle: Authentication\nicon: fa-key\n---\nHow requests are authenticated.\n',
    'docs/getting-started/authentication/_order.yaml': '- api-keys\n',
    'docs/getting-started/authentication/api-keys.md': '---\ntitle: API keys\n---\nRotate keys often.\n',
    'docs/guides/webhooks.md': '---\ntitle: Webhooks\nhidden: true\n---\nComing soon.\n',
    'reference/payments.yaml': PETSTORE_YAML,
    'reference/payments/list-payments.md':
      '---\napi:\n  file: payments.yaml\n  operationId: listPayments\n---\n',
    'reference/errors.md': '---\ntitle: Errors\n---\nError codes.\n',
    'changelogs/2025-01-15-launch.md':
      '---\ntitle: Launch\ntype: added\ndate: 2025-01-15\n---\nWe launched.\n',
    'custom_pages/terms.md': '---\ntitle: Terms\nfullscreen: false\n---\nThe terms.\n',
  }
}

function harness(
  files: Record<string, string> = readmeRepositoryFiles(),
  options: {
    publishMode?: ReadmePublishMode
    root?: string
    branch?: string | null
    draftPullRequests?: boolean
  } = {},
) {
  const repo = new FakeRepository(files)
  const store = new MemoryReadmeStore(repo.id)
  const root = options.root ?? ''
  const branch = options.branch ?? null
  // The editor may store HTML; these tests keep Markdown, so this is identity.
  const toMarkdown = (content: string | null | undefined): string => content ?? ''
  const deps = { store, toMarkdown, ...repo.github() }
  const source = (): ReadmePublishSource => ({
    installationId: 7,
    repoId: repo.id,
    repoFullName: repo.fullName,
    root,
    branch,
    lastSyncCommitSha: (store.source.last_sync_commit_sha as string | undefined) ?? null,
    syncState: store.source.sync_state ?? null,
    publishMode: options.publishMode ?? 'direct',
    publishPullRequestNumber: (store.source.publish_pull_request_number as number | undefined) ?? null,
    publishPullRequestHead: (store.source.publish_pull_request_head as string | undefined) ?? null,
    draftPullRequests: options.draftPullRequests,
  })
  return {
    repo,
    store,
    sync: (syncOptions: { mode?: ReadmeSyncMode; force?: boolean } = {}) => {
      repo.blobReads = []
      return syncReadmeRepository(
        {
          installationId: 7,
          repoId: repo.id,
          repoFullName: repo.fullName,
          root,
          branch,
          lastSyncCommitSha: source().lastSyncCommitSha,
          syncState: source().syncState,
          mode: syncOptions.mode ?? 'merge',
          force: syncOptions.force,
        },
        deps,
      )
    },
    inspect: () => inspectReadmePublish(source(), deps),
    diff: () => diffReadmePublish(source(), deps),
    publish: (publishOptions: Parameters<typeof publishReadmeWorkspace>[2] = {}) =>
      publishReadmeWorkspace(source(), deps, publishOptions),
    commitSpec: (input: Parameters<typeof commitReadmeSpecFile>[2]) =>
      commitReadmeSpecFile(source(), deps, input),
  }
}

describe('ReadMe-format GitHub sync: repository -> workspace', () => {
  it('imports a ReadMe repository as folders, pages and API definitions', async () => {
    const { store, sync } = harness()
    const result = await sync()

    // Guide categories are top-level folders; other sections get one folder.
    const gettingStarted = store.folder('docs/getting-started')
    expect(gettingStarted).toMatchObject({ displayName: 'Getting Started', parentId: null, sortOrder: 0 })
    expect(store.folder('docs/guides')).toMatchObject({ parentId: null, sortOrder: 1 })
    expect(store.folder('reference')).toMatchObject({ displayName: 'API Reference', parentId: null })
    expect(store.folder('changelogs').displayName).toBe('Changelog')
    expect(store.folder('custom_pages').displayName).toBe('Custom Pages')

    // A page with child pages is a folder whose landing content is index.md.
    const authentication = store.folder('docs/getting-started/authentication')
    expect(authentication).toMatchObject({
      displayName: 'Authentication',
      parentId: gettingStarted.id,
      sortOrder: 1,
      content: 'How requests are authenticated.',
    })

    const quickstart = store.document('docs/getting-started/quickstart.md')
    expect(quickstart).toMatchObject({
      title: 'Quickstart',
      status: 'Published',
      folderId: gettingStarted.id,
      sortOrder: 0,
      publicSlug: 'quickstart',
    })
    // MDX the editor cannot express is flattened to Markdown in Breezify...
    expect(quickstart.content).toBe('Install the SDK.\n\n> 📘\n>\n> Sandbox keys start with `sk_test`.')
    // ...and the whole frontmatter is kept for the way back.
    expect(quickstart.metadata?.readme_frontmatter).toMatchObject({
      excerpt: 'Take your first payment.',
      metadata: { title: 'Quickstart | Breeze', robots: 'index' },
      next: { pages: [{ slug: 'api-keys', type: 'basic' }] },
    })

    expect(store.document('API keys')).toMatchObject({ folderId: authentication.id, sortOrder: 0 })
    // hidden: true is an unpublished page.
    expect(store.document('Webhooks').status).toBe('Draft')
    expect(store.document('Launch').metadata?.published_date).toBe('2025-01-15T00:00:00.000Z')
    expect(store.document('Errors').folderId).toBe(store.folder('reference').id)

    // The OpenAPI definition goes through the existing OpenAPI source sync...
    expect(store.specs.get('payments')).toMatchObject({
      repoPath: 'reference/payments.yaml',
      specRaw: PETSTORE_YAML,
      operationCount: 1,
    })
    // ...so the per-operation stub ReadMe generates is not imported as a page.
    expect(result.skipped).toEqual([
      expect.objectContaining({ path: 'reference/payments/list-payments.md', quiet: true }),
    ])
    expect(store.liveDocuments().map((document) => document.title).sort()).toEqual([
      'API keys', 'Errors', 'Launch', 'Quickstart', 'Terms', 'Webhooks',
    ])
    expect(store.source).toMatchObject({ sync_status: 'synced', conflict_count: 0, document_count: 7 })
    expect(result).toMatchObject({ created: 7, updated: 0, removed: 0 })
  })

  it('reads only the blobs that changed on later syncs', async () => {
    const { repo, store, sync } = harness()
    await sync()
    // Same commit: nothing to do, nothing fetched.
    await sync()
    expect(repo.blobReads).toEqual([])

    repo.push({
      'docs/getting-started/authentication/api-keys.md':
        '---\ntitle: API keys\n---\nRotate keys every 90 days.\n',
    })
    const result = await sync()
    expect(repo.blobReads).toEqual(['docs/getting-started/authentication/api-keys.md'])
    expect(result).toMatchObject({ created: 0, updated: 1, removed: 0 })
    expect(store.document('API keys').content).toBe('Rotate keys every 90 days.')
    // The previous version is kept as a document version, not lost.
    expect(store.snapshots).toEqual([
      expect.objectContaining({ title: 'API keys', content: 'Rotate keys often.' }),
    ])
  })

  it('keeps a hidden page hidden when its content changes on GitHub', async () => {
    const { repo, store, sync } = harness()
    await sync()
    expect(store.document('Webhooks').status).toBe('Draft')
    repo.push({ 'docs/guides/webhooks.md': '---\ntitle: Webhooks\nhidden: true\n---\nStill not ready.\n' })
    await sync()
    expect(store.document('Webhooks')).toMatchObject({ content: 'Still not ready.', status: 'Draft' })

    // Un-hiding on GitHub publishes it; a page unpublished in Breezify stays so.
    repo.push({ 'docs/guides/webhooks.md': '---\ntitle: Webhooks\nhidden: false\n---\nReady.\n' })
    await sync()
    expect(store.document('Webhooks').status).toBe('Published')
    store.document('Errors').status = 'Draft'
    repo.push({ 'reference/errors.md': '---\ntitle: Errors\n---\nMore error codes.\n' })
    await sync()
    // Breezify changed only the visibility, so GitHub's content still applies.
    expect(store.document('Errors')).toMatchObject({ content: 'More error codes.', status: 'Draft' })
  })

  it('follows a changed _order.yaml without re-reading the pages', async () => {
    const { repo, store, sync } = harness()
    await sync()
    repo.push({ 'docs/getting-started/_order.yaml': '- authentication\n- quickstart\n' })
    await sync()
    expect(repo.blobReads).toEqual(['docs/getting-started/_order.yaml'])
    expect(store.document('Quickstart').sortOrder).toBe(1)
    expect(store.folder('Authentication').sortOrder).toBe(0)
  })

  it('keeps the document when a file is renamed or moved on GitHub', async () => {
    const { repo, store, sync } = harness()
    await sync()
    const before = store.document('Quickstart')
    repo.push({
      'docs/getting-started/quickstart.md': null,
      'docs/guides/quick-start.md': QUICKSTART,
    })
    const result = await sync()
    const after = store.document('Quickstart')
    expect(after.id).toBe(before.id)
    expect(after.publicSlug).toBe('quickstart')
    expect(after.folderId).toBe(store.folder('docs/guides').id)
    expect(after.metadata?.canonical_repo_path).toBe('docs/guides/quick-start.md')
    expect(result).toMatchObject({ created: 0, removed: 0 })
  })

  it('removes pages deleted on GitHub, but keeps ones edited in Breezify', async () => {
    const { repo, store, sync } = harness()
    await sync()
    store.document('Errors').content = 'Error codes, rewritten in Breezify.'
    repo.push({ 'reference/errors.md': null, 'custom_pages/terms.md': null })
    const result = await sync()

    expect(store.liveDocuments().map((document) => document.title)).not.toContain('Terms')
    // Its folder had nothing else in it.
    expect([...store.folders.values()].map((folder) => folder.displayName)).not.toContain('Custom Pages')
    // The edited page survives, flagged for a person to decide.
    expect(store.document('Errors').metadata).toMatchObject({
      github_hosted_sync: false,
      github_hosted_conflict: true,
      github_hosted_detached_reason: 'source_removed',
    })
    expect(result.removed).toBe(1)
    expect(store.source.conflict_count).toBe(1)
  })

  it('imports a page again when its file returns after being deleted on GitHub', async () => {
    const { repo, store, sync } = harness()
    await sync()
    repo.push({ 'custom_pages/terms.md': null })
    await sync()
    expect(store.liveDocuments().map((document) => document.title)).not.toContain('Terms')

    // The trashed document must not keep the path to itself.
    repo.push({ 'custom_pages/terms.md': '---\ntitle: Terms\n---\nThe terms, again.\n' })
    await sync()
    expect(store.document('custom_pages/terms.md').content).toBe('The terms, again.')
  })

  it('flags a conflict instead of overwriting when both sides changed a page', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    store.document('API keys').content = 'Edited in Breezify.'
    repo.push({
      'docs/getting-started/authentication/api-keys.md': '---\ntitle: API keys\n---\nEdited on GitHub.\n',
    })
    await sync()
    expect(store.document('API keys').content).toBe('Edited in Breezify.')
    expect(store.document('API keys').metadata?.github_hosted_conflict).toBe(true)
    expect(store.source.conflict_count).toBe(1)

    // Publishing leaves the conflicted page alone...
    expect(await inspect()).toMatchObject({ status: 'up_to_date', conflictCount: 1 })
    // ...until someone says Breezify wins.
    await publish({ includeConflicts: true })
    expect(repo.file('docs/getting-started/authentication/api-keys.md')).toBe(
      '---\ntitle: API keys\n---\nEdited in Breezify.\n',
    )
    expect(store.document('API keys').metadata?.github_hosted_conflict).toBe(false)
    expect(store.source.conflict_count).toBe(0)
  })

  it('lets GitHub win everywhere in replace mode', async () => {
    const { repo, store, sync } = harness()
    await sync()
    store.document('API keys').content = 'Edited in Breezify.'
    repo.push({
      'docs/getting-started/authentication/api-keys.md': '---\ntitle: API keys\n---\nEdited on GitHub.\n',
    })
    await sync({ mode: 'replace_breezify' })
    expect(store.document('API keys').content).toBe('Edited on GitHub.')
    expect(store.source.conflict_count).toBe(0)
  })

  it('skips unreadable pages without failing the sync or deleting their documents', async () => {
    const { repo, store, sync } = harness()
    await sync()
    repo.push({ 'reference/errors.md': '---\ntitle: [unclosed\n---\nBroken.\n' })
    const result = await sync()
    expect(store.source.sync_status).toBe('synced')
    expect(store.document('Errors').content).toBe('Error codes.')
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ path: 'reference/errors.md', reason: expect.stringMatching(/not valid YAML/) }),
    )
  })

  it('syncs a project that lives in a subdirectory', async () => {
    const files = Object.fromEntries(
      Object.entries(readmeRepositoryFiles()).map(([path, content]) => [`site/${path}`, content]),
    )
    const { store, sync } = harness({ ...files, 'docs/unrelated.md': '# elsewhere\n' }, { root: 'site' })
    await sync()
    expect(store.document('Quickstart').metadata?.canonical_repo_path).toBe(
      'site/docs/getting-started/quickstart.md',
    )
    expect(store.liveDocuments()).toHaveLength(6)
    expect(store.specs.get('payments')?.repoPath).toBe('site/reference/payments.yaml')
  })

  it('removes an API definition whose file was deleted on GitHub', async () => {
    const { repo, store, sync } = harness()
    await sync()
    repo.push({ 'reference/payments.yaml': null })
    await sync()
    expect(store.specs.has('payments')).toBe(false)
  })
})

describe('ReadMe-format GitHub sync: linking a workspace that already has pages', () => {
  it('adopts a page that holds the same URL slug instead of importing a copy', async () => {
    const { store, sync, inspect } = harness()
    const old = store.authorFolder('Imported docs')
    const existing = store.authorDocument({
      title: 'Webhooks',
      content: 'Coming soon.\n',
      folderId: old.id,
      publicSlug: 'webhooks',
    })
    const result = await sync()

    expect(result.adopted).toBe(1)
    expect(store.liveDocuments().filter((document) => document.title === 'Webhooks')).toHaveLength(1)
    const adopted = store.document('docs/guides/webhooks.md')
    expect(adopted.id).toBe(existing.id)
    // It keeps its URL and takes its place in the repository's tree.
    expect(adopted.publicSlug).toBe('webhooks')
    expect(adopted.folderId).toBe(store.folder('docs/guides').id)
    expect(adopted.metadata?.github_hosted_conflict).toBe(false)
    // The folder the page left is gone with it, and there is nothing to send
    // back: the workspace and the repository agree.
    expect(store.folders.has(old.id)).toBe(false)
    expect(await inspect()).toMatchObject({ status: 'up_to_date', changedFileCount: 0, conflictCount: 0 })
  })

  it('keeps the workspace text of an adopted page that differs, until someone chooses', async () => {
    const { repo, store, sync, inspect } = harness()
    const before = repo.files()
    store.authorDocument({ title: 'API keys', content: 'Written in Breezify.', publicSlug: 'api-keys' })
    const result = await sync()

    expect(result).toMatchObject({ adopted: 1, preserved: 1 })
    const adopted = store.document('docs/getting-started/authentication/api-keys.md')
    expect(adopted.content).toBe('Written in Breezify.')
    expect(adopted.metadata?.github_hosted_conflict).toBe(true)
    expect(adopted.folderId).toBe(store.folder('docs/getting-started/authentication').id)
    expect(store.source.conflict_count).toBe(1)
    // The difference is a conflict to resolve, not a change to publish.
    expect(await inspect()).toMatchObject({ status: 'up_to_date', conflictCount: 1 })
    expect(repo.files()).toEqual(before)

    // A later sync does not undo the choice that is still open.
    repo.push({ 'README.md': '# changed\n' })
    await sync()
    expect(store.document('API keys').content).toBe('Written in Breezify.')

    // "Use GitHub" takes the repository's version and keeps the old one in history.
    await sync({ mode: 'replace_breezify' })
    expect(store.document('API keys').content).toBe('Rotate keys often.')
    expect(store.document('API keys').metadata?.github_hosted_conflict).toBe(false)
    expect(store.snapshots).toContainEqual(
      expect.objectContaining({ id: adopted.id, content: 'Written in Breezify.' }),
    )
    expect(await inspect()).toMatchObject({ status: 'up_to_date', changedFileCount: 0, conflictCount: 0 })
  })

  it('matches a page by its file name when the frontmatter sets another slug', async () => {
    const { store, sync } = harness({
      ...readmeRepositoryFiles(),
      'docs/guides/payouts.md': '---\ntitle: Payouts\nslug: guides-payouts\n---\nHow payouts work.\n',
    })
    const existing = store.authorDocument({
      title: 'Payouts',
      content: 'How payouts work.\n',
      publicSlug: 'payouts',
    })
    const result = await sync()
    expect(result.adopted).toBe(1)
    expect(store.document('docs/guides/payouts.md').id).toBe(existing.id)
    expect(store.liveDocuments().filter((document) => document.title === 'Payouts')).toHaveLength(1)
  })

  it('adopts a page for a file added on GitHub after the first sync', async () => {
    const { repo, store, sync } = harness()
    await sync()
    const draft = store.authorDocument({ title: 'Refunds', content: 'Draft.', publicSlug: 'refunds' })
    repo.push({ 'docs/guides/refunds.md': '---\ntitle: Refunds\n---\nFrom GitHub.\n' })
    const result = await sync()
    expect(result).toMatchObject({ adopted: 1, created: 0 })
    expect(store.document('docs/guides/refunds.md').id).toBe(draft.id)
    expect(draft.content).toBe('Draft.')
    expect(draft.metadata?.github_hosted_conflict).toBe(true)
  })

  it('never adopts restricted pages, API reference pages or pages tied to a repository', async () => {
    const { store, sync } = harness()
    const internal = store.authorFolder('Internal')
    internal.restricted = true
    const restricted = store.authorDocument({
      title: 'Webhooks',
      content: 'Private notes.',
      folderId: internal.id,
      publicSlug: 'webhooks',
    })
    const reference = store.authorDocument({ title: 'API keys', content: 'GET /keys', publicSlug: 'api-keys' })
    reference.metadata = { api_reference: { format: 'openapi', operation_id: 'listKeys' } }
    const detached = store.authorDocument({ title: 'Quickstart', content: 'Old.', publicSlug: 'quickstart' })
    detached.metadata = { repo_id: 7, canonical_repo_path: 'docs/quickstart.md', github_hosted_sync: false }

    const result = await sync()
    expect(result.adopted).toBe(0)
    expect(restricted.content).toBe('Private notes.')
    expect(restricted.folderId).toBe(internal.id)
    expect(reference.metadata).toEqual({ api_reference: { format: 'openapi', operation_id: 'listKeys' } })
    expect(detached.content).toBe('Old.')
    // The repository's pages were imported beside them, under free slugs.
    expect(store.document('docs/guides/webhooks.md').id).not.toBe(restricted.id)
    expect(store.document('docs/guides/webhooks.md').publicSlug).not.toBe('webhooks')
  })

  it('does not publish API reference pages or the empty folders around them', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    const before = repo.files()
    const reference = store.authorFolder('API Reference')
    reference.sortOrder = 0
    const tag = store.authorFolder('Customers', reference.id)
    tag.sortOrder = 0
    const operation = store.authorDocument({
      title: 'Get a customer',
      content: 'GET /customers/{id}',
      folderId: tag.id,
      status: 'Published',
      publicSlug: 'getcustomerbyid',
    })
    operation.metadata = { api_reference: { format: 'openapi', operation_id: 'getCustomerById' } }
    const emptied = store.authorFolder('Left behind')
    emptied.sortOrder = 1

    expect(await inspect()).toMatchObject({ status: 'up_to_date', changedFileCount: 0 })
    await expect(publish()).rejects.toMatchObject({ code: 'no_changes' })
    expect(repo.files()).toEqual(before)
    // Not linked to a directory that does not exist, so a later sync cannot
    // mistake them for folders whose directory was deleted.
    expect(reference.metadata).toEqual({})
    expect(tag.metadata).toEqual({})
    expect(emptied.metadata).toEqual({})
  })

  it('keeps the pages of a directory deleted on GitHub in the trash when its folder goes', async () => {
    const { repo, store, sync } = harness()
    await sync()
    const page = store.document('docs/guides/webhooks.md')
    const folder = store.folder('docs/guides')
    repo.push({ 'docs/guides/webhooks.md': null })
    await sync()
    expect(store.folders.has(folder.id)).toBe(false)
    // Deleting a folder deletes what is filed in it, so the page is unfiled first.
    expect(store.documents.get(page.id)).toMatchObject({ deleted: true, folderId: null })
  })

  it('removes the folders adoption emptied, and nothing else', async () => {
    const { store, sync } = harness()
    const imported = store.authorFolder('Imported docs')
    const guides = store.authorFolder('Guides', imported.id)
    store.authorDocument({ title: 'Webhooks', content: 'Coming soon.\n', folderId: guides.id, publicSlug: 'webhooks' })
    // Emptied too, but it has a landing page of its own to lose.
    const described = store.authorFolder('Described')
    described.content = 'About this section.'
    store.authorDocument({ title: 'API keys', content: 'Rotate keys often.\n', folderId: described.id, publicSlug: 'api-keys' })
    // Still holds a page that is not in the repository.
    const mixed = store.authorFolder('Mixed')
    store.authorDocument({ title: 'Quickstart', content: 'Ship it.\n', folderId: mixed.id, publicSlug: 'quickstart' })
    const notes = store.authorDocument({ title: 'Notes', content: 'Ours.', folderId: mixed.id, publicSlug: 'notes' })
    // Never touched by the sync.
    const fresh = store.authorFolder('Just created')

    const result = await sync()
    expect(result.adopted).toBe(3)
    // The folder the page left goes, and then the parent that leaves empty.
    expect(store.folders.has(guides.id)).toBe(false)
    expect(store.folders.has(imported.id)).toBe(false)
    expect(store.folders.has(described.id)).toBe(true)
    expect(store.folders.has(mixed.id)).toBe(true)
    expect(store.folders.has(fresh.id)).toBe(true)
    expect(store.document('Notes').id).toBe(notes.id)
  })

  it('"Use GitHub" trashes the pages the repository does not have and removes the folders that empties', async () => {
    const { store, sync, inspect } = harness()
    await sync()
    const imported = store.authorFolder('Imported docs')
    const section = store.authorFolder('Old section', imported.id)
    const extra = store.authorDocument({ title: 'Old page', content: 'Only here.', folderId: section.id, publicSlug: 'old-page' })
    const loose = store.authorDocument({ title: 'Loose page', content: 'Only here.', publicSlug: 'loose-page' })
    const empty = store.authorFolder('Empty')
    // Kept: API reference pages and their folders, and role-restricted content.
    const reference = store.authorFolder('API Reference')
    const operation = store.authorDocument({ title: 'Get a customer', content: 'GET /customers/{id}', folderId: reference.id })
    operation.metadata = { api_reference: { format: 'openapi', operation_id: 'getCustomerById' } }
    const internal = store.authorFolder('Internal')
    internal.restricted = true
    const runbook = store.authorDocument({ title: 'Runbook', content: 'Private.', folderId: internal.id })
    const linked = store.liveDocuments().filter((document) => document.metadata?.github_hosted_sync === true)

    // An ordinary sync leaves all of it where it is.
    await sync({ force: true })
    expect(store.liveDocuments()).toContain(extra)
    expect(store.folders.has(empty.id)).toBe(true)

    const result = await sync({ mode: 'replace_breezify' })
    expect(result.removed).toBe(2)
    expect(extra.deleted).toBe(true)
    expect(loose.deleted).toBe(true)
    // In the trash, not gone with its folder.
    expect(store.documents.has(extra.id)).toBe(true)
    expect(extra.folderId).toBeNull()
    expect(store.folders.has(section.id)).toBe(false)
    expect(store.folders.has(imported.id)).toBe(false)
    expect(store.folders.has(empty.id)).toBe(false)
    expect(operation.deleted).toBe(false)
    expect(store.folders.has(reference.id)).toBe(true)
    expect(runbook.deleted).toBe(false)
    expect(store.folders.has(internal.id)).toBe(true)
    // Every page of the repository is still there, and nothing waits to be published.
    expect(linked.every((document) => !document.deleted)).toBe(true)
    expect(store.folder('docs/guides')).toBeDefined()
    expect(await inspect()).toMatchObject({ status: 'up_to_date', changedFileCount: 0 })
  })

  it('"Use GitHub" clears nothing when the repository has no pages to show for it', async () => {
    const { store, sync } = harness({ 'README.md': '# Not a docs project\n' })
    const kept = store.authorDocument({ title: 'Only here', content: 'Ours.', publicSlug: 'only-here' })
    const folder = store.authorFolder('Ours')
    await sync({ mode: 'replace_breezify' })
    expect(kept.deleted).toBe(false)
    expect(store.folders.has(folder.id)).toBe(true)
  })
})

describe('ReadMe-format GitHub sync: workspace -> repository', () => {
  it('has nothing to publish right after a sync', async () => {
    const { sync, inspect } = harness()
    await sync()
    expect(await inspect()).toMatchObject({ status: 'up_to_date', changedFileCount: 0 })
  })

  it('commits an edit straight to the branch, touching only that file', async () => {
    const { repo, store, sync, inspect, diff, publish } = harness()
    await sync()
    const before = repo.files()
    const quickstart = store.document('Quickstart')
    quickstart.title = 'Quick start'
    quickstart.content = 'Install the SDK, then take a payment.'

    expect(await inspect()).toMatchObject({ status: 'changes', changedFileCount: 1 })
    expect((await diff()).files).toEqual([
      expect.objectContaining({
        path: 'docs/getting-started/quickstart.md',
        status: 'modified',
        previous: QUICKSTART,
      }),
    ])

    const result = await publish()
    expect(result).toMatchObject({ mode: 'direct', branch: 'main', changedFileCount: 1 })
    expect(repo.lastMessage()).toBe('docs: update docs/getting-started/quickstart.md from Breezify')

    const after = repo.files()
    const changed = Object.keys(after).filter((path) => after[path] !== before[path])
    expect(changed).toEqual(['docs/getting-started/quickstart.md'])
    const written = parseReadmeFile(after['docs/getting-started/quickstart.md']!)
    // Title is Breezify's; every other frontmatter key is exactly as it was.
    expect(written.frontmatter).toEqual({
      title: 'Quick start',
      excerpt: 'Take your first payment.',
      hidden: false,
      metadata: { title: 'Quickstart | Breeze', robots: 'index' },
      next: { pages: [{ slug: 'api-keys', type: 'basic' }] },
    })
    expect(written.body).toBe('Install the SDK, then take a payment.\n')

    // The workspace is now in step with the new commit: nothing left to
    // publish, and the push webhook for our own commit reads no blobs.
    expect(store.source.last_sync_commit_sha).toBe(repo.head())
    expect(await inspect()).toMatchObject({ status: 'up_to_date' })
    await sync()
    expect(repo.blobReads).toEqual([])
    expect(store.snapshots).toEqual([])
  })

  it('writes new folders and pages in the ReadMe layout and links them', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    const folder = store.authorFolder('Going Live')
    folder.content = 'Checklist before launch.'
    store.authorDocument({ title: 'Go-live checklist', content: 'Rotate your keys.', folderId: folder.id })
    store.authorDocument({
      title: 'Refunds',
      content: 'How refunds work.',
      folderId: store.folder('docs/guides').id,
      status: 'Published',
      publicSlug: 'refunds-guide',
    })
    await publish()

    expect(repo.file('docs/going-live/index.md')).toBe(
      '---\ntitle: Going Live\nhidden: false\n---\nChecklist before launch.\n',
    )
    // A draft is a hidden page on GitHub.
    expect(repo.file('docs/going-live/go-live-checklist.md')).toBe(
      '---\ntitle: Go-live checklist\nhidden: true\n---\nRotate your keys.\n',
    )
    // The file is named after the page's URL slug.
    expect(repo.file('docs/guides/refunds-guide.md')).toBe(
      '---\ntitle: Refunds\nhidden: false\n---\nHow refunds work.\n',
    )
    expect(repo.lastMessage()).toMatch(/^docs: sync 3 files from Breezify\n\n- docs\/going-live\/go-live-checklist\.md/)

    // A later push from GitHub must not import copies of what Breezify wrote.
    const documents = store.liveDocuments().length
    const folders = store.folders.size
    repo.push({ 'README.md': '# changed\n' })
    await sync()
    expect(store.liveDocuments()).toHaveLength(documents)
    expect(store.folders.size).toBe(folders)
    expect(store.folder('Going Live').metadata?.path).toBe('docs/going-live')
  })

  it('never writes role-restricted Breezify folders to GitHub', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    const internal = store.authorFolder('Internal runbooks')
    internal.restricted = true
    const nested = store.authorFolder('On-call', internal.id)
    nested.restricted = true
    store.authorDocument({ title: 'Incident playbook', content: 'Private.', folderId: nested.id })
    expect(await inspect()).toMatchObject({ status: 'up_to_date', changedFileCount: 0 })

    store.authorDocument({ title: 'Public note', content: 'Fine to share.', status: 'Published' })
    await publish()
    expect(Object.keys(repo.files()).filter((path) => /internal|on-call|incident/i.test(path))).toEqual([])
    expect(repo.file('docs/public-note.md')).toContain('Fine to share.')
  })

  it('publishes a reorder as _order.yaml and a move as a rename', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    store.document('Quickstart').sortOrder = 1
    store.folder('Authentication').sortOrder = 0
    const errors = store.document('Errors')
    errors.folderId = store.folder('docs/guides').id
    await publish()

    expect(parseOrderFile(repo.file('docs/getting-started/_order.yaml')!)).toEqual([
      'authentication', 'quickstart',
    ])
    expect(repo.file('reference/errors.md')).toBeUndefined()
    expect(repo.file('docs/guides/errors.md')).toBe('---\ntitle: Errors\n---\nError codes.\n')
    expect(store.document('Errors').metadata?.canonical_repo_path).toBe('docs/guides/errors.md')
  })

  it('does not bring back a page deleted in Breezify, and publishes the deletion', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    store.deleteInBreezify('Terms')

    // An unrelated push arrives before the deletion was published.
    repo.push({ 'README.md': '# changed\n' })
    await sync()
    expect(store.liveDocuments().map((document) => document.title)).not.toContain('Terms')

    expect(await inspect()).toMatchObject({ status: 'changes', deletedFileCount: 1 })
    await publish()
    expect(repo.file('custom_pages/terms.md')).toBeUndefined()

    // If the file later comes back on GitHub, that is a new page again.
    repo.push({ 'custom_pages/terms.md': '---\ntitle: Terms\nfullscreen: false\n---\nThe terms.\n' })
    await sync()
    expect(store.liveDocuments().map((document) => document.title)).toContain('Terms')
  })

  it('treats a page whose document is gone entirely as deleted in Breezify', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    // Trashed, then the trash was emptied: no document row is left at all.
    store.documents.delete(store.document('Terms').id)
    repo.push({ 'README.md': '# changed\n' })
    await sync()
    expect(store.liveDocuments().map((document) => document.title)).not.toContain('Terms')
    await publish()
    expect(repo.file('custom_pages/terms.md')).toBeUndefined()
  })

  it('imports a trashed page again when GitHub changed it afterwards', async () => {
    const { repo, store, sync } = harness()
    await sync()
    store.deleteInBreezify('Terms')
    repo.push({ 'custom_pages/terms.md': '---\ntitle: Terms\n---\nNew terms.\n' })
    await sync()
    expect(store.document('Terms').content).toBe('New terms.')
  })

  it('"Use GitHub" restores everything the repository has', async () => {
    const { store, sync } = harness()
    await sync()
    store.deleteInBreezify('Terms')
    store.document('Errors').content = 'Unpublished edit.'
    await sync({ mode: 'replace_breezify' })
    expect(store.document('Terms').content).toBe('The terms.')
    expect(store.document('Errors').content).toBe('Error codes.')
  })

  it('refuses to publish over GitHub changes that were not pulled yet', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    store.document('Quickstart').content = 'Edited in Breezify.'
    repo.push({ 'README.md': '# changed\n' })
    expect(await inspect()).toMatchObject({ status: 'sync_required', code: 'github_sync_required' })
    await expect(publish()).rejects.toMatchObject({ code: 'github_sync_required', status: 409 })
  })

  it('publishes only the selected files and keeps the rest pending', async () => {
    const { repo, store, sync, inspect, publish } = harness()
    await sync()
    store.document('Quickstart').content = 'One.'
    store.document('Errors').content = 'Two.'
    await publish({ selectedPaths: ['reference/errors.md'] })
    expect(repo.file('reference/errors.md')).toContain('Two.')
    expect(repo.file('docs/getting-started/quickstart.md')).toBe(QUICKSTART)
    expect(await inspect()).toMatchObject({ status: 'changes', changedFileCount: 1 })
    await expect(publish({ selectedPaths: ['reference/errors.md'] })).rejects.toMatchObject({
      code: 'selected_paths_changed',
    })
  })

  it('explains a protected branch instead of failing obscurely', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    store.document('Quickstart').content = 'Edited in Breezify.'
    repo.protectedBranch = 'main'
    const error = await publish().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReadmePublishError)
    expect(error).toMatchObject({ code: 'branch_protected', status: 409 })
    expect((error as Error).message).toMatch(/switch publishing to pull requests/)
  })

  it('reports no_changes when there is nothing to publish', async () => {
    const { sync, publish } = harness()
    await sync()
    await expect(publish()).rejects.toMatchObject({ code: 'no_changes' })
  })
})

describe('ReadMe-format GitHub sync: pull request mode', () => {
  it('collects changes on a branch and links new pages when the PR merges', async () => {
    const { repo, store, sync, inspect, publish } = harness(undefined, { publishMode: 'pull_request' })
    await sync()
    store.document('Quickstart').content = 'Edited in Breezify.'
    store.authorDocument({ title: 'Disputes', content: 'How disputes work.', status: 'Published' })

    const first = await publish()
    expect(first).toMatchObject({ mode: 'pull_request', pullRequestNumber: 1, changedFileCount: 2 })
    expect(first.branch).toMatch(/^breezify\/readme-sync-/)
    // The synced branch is untouched until the pull request merges.
    expect(repo.file('docs/getting-started/quickstart.md')).toBe(QUICKSTART)
    expect(repo.file('docs/disputes.md', first.branch)).toBe(
      '---\ntitle: Disputes\nhidden: false\n---\nHow disputes work.\n',
    )
    expect(store.source).toMatchObject({ publish_pull_request_number: 1, publish_pull_request_head: first.branch })
    expect(await inspect()).toMatchObject({ status: 'up_to_date', pullRequestUpToDate: true })

    // A further edit extends the same pull request.
    store.document('Disputes').content = 'How disputes really work.'
    const second = await publish()
    expect(second).toMatchObject({ pullRequestNumber: 1, branch: first.branch, changedFileCount: 1 })
    expect(repo.pullRequests).toHaveLength(1)

    const documents = store.liveDocuments().length
    repo.merge(1)
    await sync()
    expect(store.liveDocuments()).toHaveLength(documents)
    expect(store.document('Disputes').metadata).toMatchObject({
      canonical_repo_path: 'docs/disputes.md',
      github_hosted_sync: true,
      github_hosted_pending_path: null,
    })
    expect(store.snapshots).toEqual([])
  })
})

describe('ReadMe-format GitHub sync: publishing options', () => {
  it('opens the publish pull request as a draft when asked to', async () => {
    const { repo, store, sync, publish } = harness(readmeRepositoryFiles(), {
      publishMode: 'pull_request',
      draftPullRequests: true,
    })
    await sync()
    store.document('API keys').content = 'Edited in Breezify.'
    await publish()
    expect(repo.pullRequests).toEqual([expect.objectContaining({ number: 1, draft: true })])
  })

  it('opens a normal pull request where the repository does not allow drafts', async () => {
    const { repo, store, sync, publish } = harness(readmeRepositoryFiles(), {
      publishMode: 'pull_request',
      draftPullRequests: true,
    })
    repo.draftsUnsupported = true
    await sync()
    store.document('API keys').content = 'Edited in Breezify.'
    const result = await publish()
    expect(result.pullRequestNumber).toBe(1)
    expect(repo.pullRequests).toEqual([expect.objectContaining({ number: 1, draft: false })])
  })

  it('credits the editors of the published pages as commit co-authors', async () => {
    const { repo, store, sync, publish } = harness()
    await sync()
    const edited = store.document('API keys')
    edited.content = 'Edited in Breezify.'
    const asked: string[][] = []
    await publish({
      coAuthors: async (documentIds) => {
        asked.push(documentIds)
        return [
          { name: 'Ada Lovelace', email: 'ada@breeze.test' },
          // The same person twice, a broken address and a hostile name.
          { name: 'Ada L.', email: 'ADA@breeze.test' },
          { name: 'Nobody', email: 'not-an-email' },
          { name: 'Grace <script>\nHopper', email: 'grace@breeze.test' },
        ]
      },
    })
    // Only the documents this commit writes are looked up.
    expect(asked).toEqual([[edited.id]])
    expect(repo.lastMessage()).toBe(
      [
        'docs: update docs/getting-started/authentication/api-keys.md from Breezify',
        '',
        'Co-authored-by: Ada Lovelace <ada@breeze.test>',
        'Co-authored-by: Grace script Hopper <grace@breeze.test>',
      ].join('\n'),
    )
  })
})

describe('ReadMe-format GitHub sync: OpenAPI definitions', () => {
  const UPLOADED = `${JSON.stringify({ openapi: '3.1.0', info: { title: 'Payouts' }, paths: { '/payouts': { get: {} } } }, null, 2)}\n`

  it('writes an uploaded definition to reference/ as soon as it is uploaded', async () => {
    const { repo, store, sync, commitSpec } = harness()
    await sync()
    // What PUT /api/v1/openapi/payouts leaves behind: a source with no file.
    store.specs.set('payouts', { slug: 'payouts', title: 'Payouts', specRaw: UPLOADED, repoPath: null, repoBlobSha: null, operationCount: 1 })

    const outcome = await commitSpec({ slug: 'payouts', raw: UPLOADED, repoPath: null })
    expect(outcome).toMatchObject({ committed: true, path: 'reference/payouts.json' })
    expect(repo.file('reference/payouts.json')).toBe(UPLOADED)
    expect(repo.lastMessage()).toBe('docs: update OpenAPI definition payouts')
    expect(store.specs.get('payouts')?.repoPath).toBe('reference/payouts.json')

    // Our own commit coming back through the webhook changes nothing.
    await sync()
    expect(repo.blobReads).toEqual([])
    // Uploading the same definition again does not create an empty commit.
    const head = repo.head()
    expect(await commitSpec({ slug: 'payouts', raw: UPLOADED, repoPath: 'reference/payouts.json' })).toMatchObject({ committed: false })
    expect(repo.head()).toBe(head)
  })

  it('keeps a YAML file YAML when the upload is JSON', async () => {
    const { repo, store, sync, commitSpec } = harness()
    await sync()
    const raw = JSON.stringify({ openapi: '3.0.3', info: { title: 'Payments API', version: '2.0.0' }, paths: {} })
    store.specs.get('payments')!.specRaw = raw
    await commitSpec({ slug: 'payments', raw, repoPath: 'reference/payments.yaml' })
    expect(repo.file('reference/payments.yaml')).toBe(
      'openapi: 3.0.3\ninfo:\n  title: Payments API\n  version: 2.0.0\npaths: {}\n',
    )
  })

  it('picks up a definition changed on GitHub and removes one deleted in Breezify', async () => {
    const { repo, store, sync, commitSpec } = harness()
    await sync()
    repo.push({ 'reference/payments.yaml': PETSTORE_YAML.replace('1.0.0', '1.1.0') })
    const result = await sync()
    expect(store.specs.get('payments')?.specRaw).toContain('1.1.0')
    expect(result.updated).toBe(1)

    // DELETE /api/v1/openapi/payments, then the file follows.
    const repoPath = store.specs.get('payments')!.repoPath
    store.specs.delete('payments')
    expect(await commitSpec({ slug: 'payments', raw: null, repoPath })).toMatchObject({ committed: true })
    expect(repo.file('reference/payments.yaml')).toBeUndefined()
    await sync()
    expect(store.specs.has('payments')).toBe(false)
  })

  it('includes definitions in a normal publish when commits go through pull requests', async () => {
    const { repo, store, sync, publish, commitSpec } = harness(undefined, { publishMode: 'pull_request' })
    await sync()
    store.specs.set('payouts', { slug: 'payouts', title: 'Payouts', specRaw: UPLOADED, repoPath: null, repoBlobSha: null, operationCount: 1 })
    // No direct commit in pull request mode.
    expect(await commitSpec({ slug: 'payouts', raw: UPLOADED, repoPath: null })).toMatchObject({ committed: false })
    const result = await publish()
    expect(repo.file('reference/payouts.json', result.branch)).toBe(UPLOADED)
  })
})
