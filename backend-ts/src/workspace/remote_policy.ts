/** A non-local policy sentinel. Normalization is pure; resolving a local filesystem path is always refused. */
import type { Workspace } from '@oasis-code/contract'
import { PathPolicy, PathRefused, type PurePath } from './paths.ts'
import { remotePath } from './remote_files.ts'
export class RemotePathPolicy extends PathPolicy {
  constructor(readonly workspace: Workspace, protectedPaths: string[]) {
    super({ root: workspace.path, protected: protectedPaths, label: 'remote workspace', temp: null })
  }
  override normalize(path: unknown): PurePath {
    if (typeof path !== 'string') throw new PathRefused('A remote path is required.')
    const rel = remotePath(this.workspace, path)
    return rel === '.' ? [] : rel.split('/')
  }
  override resolveRead(_path: string): [PurePath, string] { throw new PathRefused('Remote paths require the SSH filesystem provider; local access is refused.') }
  override resolveWrite(_path: string): [PurePath, string] { throw new PathRefused('Remote paths require the SSH filesystem provider; local access is refused.') }
}
