import { describe, expect, it } from 'vitest'

import { MEMBERS_FOLDER_SCOPE, PUBLIC_FOLDER_SCOPE } from '@/lib/folder-visibility'

import {
  gitBlobSha,
  planReadmeExport,
  type ReadmeExportDocument,
  type ReadmeExportFolder,
} from './readme-export'
import {
  isUnlistedInRepository,
  planReadmeFolderVisibility,
  readmeFolderListing,
  type ReadmeVisibilityFolder,
} from './readme-folder-visibility'
import type { ReadmeSyncState } from './readme-layout'

const REPO = 42
const GUIDE = 'docs/Core Integration Guide'
const ORDER = { 'docs/_order.yaml': ['Core Integration Guide'], [`${GUIDE}/_order.yaml`]: ['tax'] }

function mirrored(
  id: string,
  path: string,
  overrides: Partial<ReadmeVisibilityFolder> & { recorded?: boolean } = {},
): ReadmeVisibilityFolder {
  const { recorded, ...rest } = overrides
  return {
    id,
    visibility: 'workspace',
    required_role: null,
    source_metadata: {
      kind: 'github_readme_folder',
      repo_id: REPO,
      path,
      ...(recorded === undefined ? {} : { readme_unlisted: recorded }),
    },
    ...rest,
  }
}

describe('isUnlistedInRepository', () => {
  it('is true for a directory the order file beside it leaves out', () => {
    expect(isUnlistedInRepository(mirrored('offramp', `${GUIDE}/offramp`), REPO, ORDER)).toBe(true)
    expect(isUnlistedInRepository(mirrored('tax', `${GUIDE}/tax`), REPO, ORDER)).toBe(false)
  })

  it('treats a directory with no order file beside it, or an empty one, as listed', () => {
    expect(isUnlistedInRepository(mirrored('offramp', `${GUIDE}/offramp`), REPO, {})).toBe(false)
    expect(
      isUnlistedInRepository(mirrored('offramp', `${GUIDE}/offramp`), REPO, {
        [`${GUIDE}/_order.yaml`]: [],
      }),
    ).toBe(false)
    // A section root has no directory above it to list it.
    expect(isUnlistedInRepository(mirrored('docs', 'docs'), REPO, ORDER)).toBe(false)
  })

  it('is null for a folder that is not a directory of this repository', () => {
    const local: ReadmeVisibilityFolder = {
      id: 'handbook',
      visibility: 'workspace',
      required_role: null,
      source_metadata: null,
    }
    expect(isUnlistedInRepository(local, REPO, ORDER)).toBeNull()
    expect(isUnlistedInRepository(mirrored('offramp', `${GUIDE}/offramp`), 7, ORDER)).toBeNull()
  })
})

describe('planReadmeFolderVisibility', () => {
  it('makes a public folder Members when the repository leaves it out', () => {
    expect(
      planReadmeFolderVisibility([mirrored('offramp', `${GUIDE}/offramp`)], REPO, ORDER),
    ).toEqual([{ id: 'offramp', unlisted: true, scope: MEMBERS_FOLDER_SCOPE }])
  })

  it('records a listed folder the first time without touching its visibility', () => {
    // Made Members in Breezify before the listing was ever recorded.
    const members = mirrored('tax', `${GUIDE}/tax`, { ...MEMBERS_FOLDER_SCOPE })
    expect(planReadmeFolderVisibility([members], REPO, ORDER)).toEqual([
      { id: 'tax', unlisted: false, scope: null },
    ])
  })

  it('makes a folder Public again when the repository lists it again', () => {
    const offramp = mirrored('offramp', `${GUIDE}/offramp`, { ...MEMBERS_FOLDER_SCOPE, recorded: true })
    const listed = { ...ORDER, [`${GUIDE}/_order.yaml`]: ['tax', 'offramp'] }
    expect(planReadmeFolderVisibility([offramp], REPO, listed)).toEqual([
      { id: 'offramp', unlisted: false, scope: PUBLIC_FOLDER_SCOPE },
    ])
  })

  it('leaves a change made in Breezify alone while the repository has not changed', () => {
    // Made Public in Breezify, not published yet: the repository still leaves it out.
    const offramp = mirrored('offramp', `${GUIDE}/offramp`, { recorded: true })
    // Made Members in Breezify, not published yet: the repository still lists it.
    const tax = mirrored('tax', `${GUIDE}/tax`, { ...MEMBERS_FOLDER_SCOPE, recorded: false })
    expect(planReadmeFolderVisibility([offramp, tax], REPO, ORDER)).toEqual([])
  })
})

describe('readmeFolderListing', () => {
  const base = { restricted: false, parentRestricted: false, sortOrder: 3, metadata: null }

  it('omits a folder that is not public from its parent order file', () => {
    expect(readmeFolderListing({ ...base, restricted: true })).toBe('omit')
  })

  it('leaves the order inside a non-public folder alone', () => {
    expect(readmeFolderListing({ ...base, restricted: true, parentRestricted: true })).toBeNull()
  })

  it('appends a folder the repository left out once it is Public again', () => {
    expect(
      readmeFolderListing({ ...base, sortOrder: null, metadata: { readme_unlisted: true } }),
    ).toBe('append')
    // Never listed and never hidden: it stays where it was.
    expect(readmeFolderListing({ ...base, sortOrder: null })).toBeNull()
  })
})

describe('publishing folder visibility to _order.yaml', () => {
  const orderPath = `${GUIDE}/_order.yaml`
  const state = (entries: string[]): ReadmeSyncState => ({
    format: 'readme',
    root: '',
    order_files: { [orderPath]: { sha: gitBlobSha(`${entries.map((e) => `- ${e}`).join('\n')}\n`), entries } },
    managed_paths: [orderPath],
    skipped: [],
  })
  const folder = (
    id: string,
    path: string,
    overrides: Partial<ReadmeExportFolder> = {},
  ): ReadmeExportFolder => ({
    id,
    displayName: id,
    parentId: 'guide',
    sortOrder: null,
    markdown: '',
    link: {
      path,
      indexPath: null,
      indexBlobSha: null,
      indexMarkdownHash: null,
      indexTitle: null,
      indexFrontmatter: null,
    },
    ...overrides,
  })
  const page = (id: string, folderId: string, path: string): ReadmeExportDocument => ({
    id,
    title: id,
    hidden: false,
    folderId,
    sortOrder: 0,
    publicSlug: null,
    markdown: 'Body.',
    publishedDate: null,
    link: {
      path,
      blobSha: `blob-${id}`,
      markdownHash: 'stale',
      title: id,
      hidden: false,
      frontmatter: { title: id },
      frontmatterRaw: null,
      conflict: false,
    },
  })
  const plan = (folders: ReadmeExportFolder[], entries: string[]) => {
    const current = state(entries)
    return planReadmeExport({
      root: '',
      // A guide category is a top-level folder; `docs/` itself is not one.
      folders: [folder('guide', GUIDE, { parentId: null, sortOrder: 0 }), ...folders],
      documents: [
        page('tax-page', 'tax', `${GUIDE}/tax/sales-tax.md`),
        page('offramp-page', 'offramp', `${GUIDE}/offramp/overview.md`),
      ],
      specs: [],
      tree: new Map([
        [orderPath, current.order_files[orderPath]!.sha],
        [`${GUIDE}/tax/sales-tax.md`, 'blob-tax-page'],
        [`${GUIDE}/offramp/overview.md`, 'blob-offramp-page'],
      ]),
      state: current,
    })
  }
  const written = (result: ReturnType<typeof plan>): string | undefined =>
    result.writes.find((write) => write.path === orderPath)?.content

  it('takes a folder that was made Members out of the order file', () => {
    const result = plan(
      [
        folder('tax', `${GUIDE}/tax`, { sortOrder: 0 }),
        folder('offramp', `${GUIDE}/offramp`, { sortOrder: 1, listing: 'omit' }),
      ],
      ['tax', 'offramp'],
    )
    expect(written(result)).toBe('- tax\n')
  })

  it('lists a folder that was made Public again at the end', () => {
    const result = plan(
      [
        folder('tax', `${GUIDE}/tax`, { sortOrder: 0 }),
        folder('offramp', `${GUIDE}/offramp`, { listing: 'append' }),
      ],
      ['tax'],
    )
    expect(written(result)).toBe('- tax\n- offramp\n')
  })

  it('keeps an unlisted folder unlisted when nothing changed', () => {
    const result = plan(
      [
        folder('tax', `${GUIDE}/tax`, { sortOrder: 0 }),
        folder('offramp', `${GUIDE}/offramp`, { listing: 'omit' }),
      ],
      ['tax'],
    )
    expect(written(result)).toBeUndefined()
  })
})
