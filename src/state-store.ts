/**
 * Small, crash-safe JSON persistence.
 *
 * Written by hand rather than pulled from `@deepseek-ai/dsh-atomic-write`: that
 * package is a host-internal dependency, and a monitoring plugin that cannot be
 * installed because it guessed a host package name is worthless. The write
 * recipe below (temp file in the same directory, then rename) is the one that
 * is atomic on POSIX and recoverable on Windows, where renaming over an
 * existing file fails and the target has to be removed first.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Path of a keelwatch state file inside `$DSH_HOME`. */
export function stateFilePath(dshHome: string, file: string): string {
  return join(dshHome, 'keelwatch', file)
}

/** Read JSON, treating any failure (missing, truncated, malformed) as absent. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function renameInto(placeholder: string, target: string): Promise<void> {
  try {
    await rename(placeholder, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') throw error
    // Windows cannot rename onto an existing file: drop it first. The window
    // between unlink and rename leaves no target, which is why readers treat a
    // missing file as "no state" instead of an error.
    await rm(target, { force: true })
    await rename(placeholder, target)
  }
}

/**
 * Write JSON atomically.
 *
 * Returns `false` instead of throwing: persistence is an enhancement here, and
 * a read-only or full disk must not turn into a plugin failure.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<boolean> {
  const placeholder = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(placeholder, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await renameInto(placeholder, path)
    return true
  } catch {
    // Best effort cleanup; a stale temp file is harmless.
    await rm(placeholder, { force: true }).catch(() => undefined)
    return false
  }
}
