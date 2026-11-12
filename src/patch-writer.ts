/**
 * The profile patch writer used by the configuration page.
 *
 * Why not `ctx.configEditor`: that service only addresses rows the *profile's own*
 * include tree declares (`entries()` filters on an `include` parent), while a
 * bundle's row arrives through the bundle layer. Verified against this host:
 * `configEditor.configuration()` simply had no `keelwatch` row, so the page
 * answered "row keelwatch not found".
 *
 * So the page owns its row directly, under rules that keep the file safe:
 *
 * - only one row is ever touched, identified by its exact `- id: <rowId>`;
 * - the config value is written as a single-line JSON flow mapping, which is
 *   valid YAML — no YAML parser, no re-serialization of the user's file;
 * - everything else in the file is preserved byte for byte;
 * - the file is backed up before the first modification and replaced atomically.
 */
import { copyFile, readFile } from 'node:fs/promises'
import { writeTextAtomic } from './state-store.js'

/** Marks the block this plugin owns, so a human reading the file knows. */
export const ROW_MARKER = '# keelwatch: config managed by the plugin page'

/** System-agnostic row id; also the Loader entry id in the bundle patch. */
export const ROW_ID = 'keelwatch'

export interface RowRead {
  readonly found: boolean
  /** Parsed JSON config written by this plugin, when present. */
  readonly config: Record<string, unknown> | null
  /** The raw `config:` line, for diagnostics. */
  readonly raw: string | null
}

function isRowStart(line: string, rowId: string): boolean {
  return new RegExp(`^\\s*-\\s*id:\\s*['"]?${rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`).test(line)
}

/** A patch file's entries start at column 0 with `- `. */
function isTopLevelEntry(line: string): boolean {
  return /^-\s/.test(line)
}

/** Index range [start, end) of the row's block. */
function locateBlock(lines: readonly string[], rowId: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => isRowStart(line, rowId))
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isTopLevelEntry(lines[index] ?? '')) {
      end = index
      break
    }
  }
  return { start, end }
}

/** Read the config this plugin previously wrote for its row. */
export async function readRowConfig(patchPath: string, rowId: string = ROW_ID): Promise<RowRead> {
  let text: string
  try {
    text = await readFile(patchPath, 'utf8')
  } catch {
    return { found: false, config: null, raw: null }
  }
  const lines = text.split('\n')
  const block = locateBlock(lines, rowId)
  if (block === null) return { found: false, config: null, raw: null }

  for (let index = block.start; index < block.end; index += 1) {
    const line = lines[index] ?? ''
    const match = /^\s*config:\s*(.+)$/.exec(line)
    if (match === null) continue
    const raw = match[1] ?? ''
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        return { found: true, config: parsed as Record<string, unknown>, raw }
      }
    } catch {
      // A hand-written YAML mapping is left alone: reporting "no managed value"
      // is safer than rewriting a file we do not fully parse.
    }
    return { found: true, config: null, raw }
  }
  return { found: true, config: null, raw: null }
}

export interface WriteResult {
  readonly changed: boolean
  readonly backupPath: string | null
  readonly createdRow: boolean
}

/**
 * Persist one row's config.
 *
 * The value is written as JSON on one line under `config:`; the row's other
 * keys (`disabled`, `name`, ...) survive untouched.
 */
export async function writeRowConfig(
  patchPath: string,
  config: Record<string, unknown>,
  rowId: string = ROW_ID,
): Promise<WriteResult> {
  let text = ''
  let exists = true
  try {
    text = await readFile(patchPath, 'utf8')
  } catch {
    exists = false
    text = ''
  }

  const serialized = JSON.stringify(config)
  const configLine = `  config: ${serialized}`
  let lines = text === '' ? [] : text.split('\n')

  // An empty document (`[]` or only comments) becomes our block; a JSON flow
  // array is a valid YAML document and cannot hold block entries.
  const meaningful = lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (!exists || meaningful.length === 0 || (meaningful.length === 1 && (meaningful[0] ?? '').trim() === '[]')) {
    lines = [
      ROW_MARKER,
      `- id: ${rowId}`,
      configLine,
      '',
    ]
    const savedCopy = await createBackup(patchPath, exists)
    await writeTextAtomic(patchPath, lines.join('\n'))
    return { changed: true, backupPath: savedCopy, createdRow: true }
  }

  const block = locateBlock(lines, rowId)
  if (block === null) {
    // Append a dedicated row so the block can never be confused with a
    // neighbouring entry's keys.
    lines = [...lines.filter((line, index) => !(index === lines.length - 1 && line === '')), ROW_MARKER, `- id: ${rowId}`, configLine, '']
    const savedCopy = await createBackup(patchPath, exists)
    await writeTextAtomic(patchPath, lines.join('\n'))
    return { changed: true, backupPath: savedCopy, createdRow: true }
  }

  let replaced = false
  for (let index = block.start; index < block.end; index += 1) {
    if (/^\s*config:\s*/.test(lines[index] ?? '')) {
      lines[index] = configLine
      replaced = true
      break
    }
  }
  if (!replaced) {
    // Insert after the row's id line so the row keeps its key order.
    lines.splice(block.start + 1, 0, configLine)
  }

  const next = lines.join('\n')
  if (next === text) return { changed: false, backupPath: null, createdRow: false }

  const savedCopy = await createBackup(patchPath, exists)
  await writeTextAtomic(patchPath, next)
  return { changed: true, backupPath: savedCopy, createdRow: false }
}

async function createBackup(patchPath: string, exists: boolean): Promise<string | null> {
  if (!exists) return null
  const target = `${patchPath}.bak-${Date.now()}`
  try {
    await copyFile(patchPath, target)
    return target
  } catch {
    return null
  }
}
