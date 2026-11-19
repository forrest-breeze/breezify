import 'server-only'

import { getRepositoryBlob, getRepositoryCommit, getRepositoryTree } from './github'
import { decodeTextBlob } from './readme/readme-sync'
import { withGitHubRetry } from './retry'

// ---------------------------------------------------------------------------
// The repository at one commit, as the docs checks read it. Several checks run
// on the same commit and mostly want the same pages, so files are fetched once
// and shared: a second read of a path waits on the first.
// ---------------------------------------------------------------------------

const BLOB_FETCH_CONCURRENCY = 6

export interface DocsCheckFile {
  /** The file decoded as UTF-8, whatever it holds. */
  raw: string
  /** False when the sync would refuse the file as binary or not UTF-8. */
  isText: boolean
}

export interface DocsCheckSnapshot {
  /** Project root inside the repository; '' is the repository root. */
  root: string
  /** Every file in the commit, with its size in bytes. */
  sizes: ReadonlyMap<string, number>
  /** True when GitHub returned only part of a very large tree. */
  truncated: boolean
  /** A file's content, or null when the commit does not have it. */
  read(path: string): Promise<DocsCheckFile | null>
}

export async function loadDocsCheckSnapshot(input: {
  token: string
  repoFullName: string
  headSha: string
  root: string
}): Promise<DocsCheckSnapshot> {
  const commit = await withGitHubRetry(() =>
    getRepositoryCommit(input.token, input.repoFullName, input.headSha),
  )
  const tree = await withGitHubRetry(() =>
    getRepositoryTree(input.token, input.repoFullName, commit.commit.tree.sha),
  )
  const blobs = new Map(
    tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry]),
  )
  const reads = new Map<string, Promise<DocsCheckFile | null>>()
  return {
    root: input.root,
    sizes: new Map([...blobs].map(([path, entry]) => [path, entry.size ?? 0])),
    truncated: tree.truncated === true,
    read(path) {
      const pending = reads.get(path)
      if (pending) return pending
      const entry = blobs.get(path)
      const read = entry
        ? withGitHubRetry(() => getRepositoryBlob(input.token, input.repoFullName, entry.sha)).then(
            (blob) =>
              blob.encoding === 'base64'
                ? {
                    raw: Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8'),
                    isText: decodeTextBlob(blob) !== null,
                  }
                : null,
          )
        : Promise.resolve(null)
      reads.set(path, read)
      return read
    },
  }
}

/** Read several files a few at a time, in the order given. */
export async function readDocsCheckFiles<T>(
  paths: readonly string[],
  read: (path: string) => Promise<T>,
): Promise<T[]> {
  const output = new Array<T>(paths.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next++
      output[index] = await read(paths[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BLOB_FETCH_CONCURRENCY, paths.length) }, () => worker()),
  )
  return output
}
