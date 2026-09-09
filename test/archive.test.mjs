import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readArchiveMarkers, writeArchiveMarkers } from '../lib/archive.mjs'

async function makeTemp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-sync-archive-'))
  return { root, clean: () => fs.rm(root, { recursive: true, force: true }) }
}

test('archive markers are additive, deterministic, and round-trip session ids', async (t) => {
  const { root, clean } = await makeTemp()
  t.after(clean)
  const repoDir = path.join(root, 'repo')

  const first = await writeArchiveMarkers({
    repoDir,
    mirrorDir: 'sessions',
    sessionIds: ['session-a', 'raw/id?unicode-ß', 'session-a'],
  })
  assert.equal(first.written, 2)
  assert.deepEqual(
    await readArchiveMarkers({ repoDir, mirrorDir: 'sessions' }),
    ['raw/id?unicode-ß', 'session-a'],
  )

  const second = await writeArchiveMarkers({
    repoDir,
    mirrorDir: 'sessions',
    sessionIds: ['session-b'],
  })
  assert.equal(second.written, 1)
  assert.deepEqual(
    await readArchiveMarkers({ repoDir, mirrorDir: 'sessions' }),
    ['raw/id?unicode-ß', 'session-a', 'session-b'],
  )
})

test('archive marker reader rejects filename/content mismatches', async (t) => {
  const { root, clean } = await makeTemp()
  t.after(clean)
  const markerRoot = path.join(root, 'repo', 'sessions', '.dsh-session-sync', 'archives')
  await fs.mkdir(markerRoot, { recursive: true })
  await fs.writeFile(path.join(markerRoot, 'wrong.json'), JSON.stringify({ version: 1, sessionId: 'session-a' }))
  await assert.rejects(
    readArchiveMarkers({ repoDir: path.join(root, 'repo'), mirrorDir: 'sessions' }),
    /filename does not match/,
  )
})
