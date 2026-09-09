// lib/archive.mjs — additive cross-device Session archive markers.
//
// DSH currently exposes archive but no unarchive surface. Represent each
// archived Session as one immutable marker file so independent devices merge
// by set union naturally in git and in the encrypted plaintext tree.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ARCHIVE_MARKER_DIR } from './constants.mjs'

function markerName(sessionId) {
  return `${Buffer.from(String(sessionId), 'utf8').toString('base64url')}.json`
}

function markerPath(repoDir, mirrorDir, sessionId) {
  return path.join(repoDir, mirrorDir, ...ARCHIVE_MARKER_DIR.split('/'), markerName(sessionId))
}

async function writeIfDifferent(target, content) {
  try {
    const existing = await fs.readFile(target)
    if (existing.equals(content)) return false
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') throw error
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}`
  await fs.writeFile(temporary, content, { mode: 0o600 })
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return true
}

/**
 * Materialize local archive membership as additive marker files.
 * Existing markers are never deleted because DSH has no unarchive operation.
 */
export async function writeArchiveMarkers({ repoDir, mirrorDir, sessionIds }) {
  let written = 0
  let unchanged = 0
  const unique = [...new Set((sessionIds ?? []).map(String))].sort()
  for (const sessionId of unique) {
    const body = Buffer.from(`${JSON.stringify({ version: 1, sessionId })}\n`)
    if (await writeIfDifferent(markerPath(repoDir, mirrorDir, sessionId), body)) written += 1
    else unchanged += 1
  }
  return { written, unchanged }
}

/**
 * Read and validate all archive markers currently present in the mirror.
 */
export async function readArchiveMarkers({ repoDir, mirrorDir }) {
  const root = path.join(repoDir, mirrorDir, ...ARCHIVE_MARKER_DIR.split('/'))
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return []
    throw error
  }

  const ids = new Set()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const absolute = path.join(root, entry.name)
    const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'))
    if (parsed?.version !== 1 || typeof parsed?.sessionId !== 'string' || parsed.sessionId.length === 0) {
      throw new Error(`invalid archive marker ${entry.name}`)
    }
    if (entry.name !== markerName(parsed.sessionId)) {
      throw new Error(`archive marker filename does not match session id: ${entry.name}`)
    }
    ids.add(parsed.sessionId)
  }
  return [...ids].sort()
}
