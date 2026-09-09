// lib/mirror.mjs — 会话目录 → git 工作树的字节镜像（node:fs；零 DSH 依赖）。
//
// 会话文件一律按不透明字节复制（JSONL/zstd 等物理编码属于宿主，插件不解析）。
// 安全边界：
// - 绝不跟随符号链接（源或目标为链接一律跳过并报告，杜绝写出根外）；
// - 删除仅限工作树内、源已不存在、且非 fork 文件的常规文件；
// - fork 文件（FORK_NAME_RE）永不复制、永不删除——冲突双方字节的持久载体。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CARRIER_DIR, FORK_NAME_RE } from './constants.mjs'

const isCarrierPath = rel => rel === CARRIER_DIR || rel.startsWith(`${CARRIER_DIR}/`)

/** 递归枚举 root 下全部常规文件（POSIX 相对路径；符号链接跳过并回报）。 */
async function listFiles(root) {
  const files = []
  const skipped = []
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        skipped.push(absolute)
        continue
      }
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (entry.isFile()) {
        files.push({ absolute, rel: path.relative(root, absolute).split(path.sep).join('/') })
      }
    }
  }
  await walk(root)
  return { files, skipped }
}

/** 内容一致则跳过写（返回 false），否则覆写（返回 true）。 */
async function writeIfDifferent(target, content) {
  try {
    const existing = await fs.readFile(target)
    if (existing.equals(content)) return false
  } catch {
    // 目标不存在 → 照写。
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  return true
}

/**
 * 把 sessionRoot 镜像进 <repoDir>/<mirrorDir>/…。
 * @param {object} deps - {sessionRoot, repoDir, mirrorDir, forkNameRe?, skipSessionIds?}。
 * @returns {Promise<{mirrored: number, unchanged: number, skippedLinks: string[], deleted: string[], forkedPreserved: string[], carriersPreserved: string[], skippedCarriers: string[], skippedSessionIds: string[]}>}
 */
export async function mirrorSessionRoot(deps) {
  const forkRe = deps.forkNameRe ?? FORK_NAME_RE
  const skipSessionIds = new Set(deps.skipSessionIds ?? [])
  const source = await listFiles(deps.sessionRoot)
  const mirrorRoot = path.join(deps.repoDir, deps.mirrorDir)
  const targets = new Set()
  const skippedSessionIds = new Set()
  const sessionIdOf = (rel) => {
    const parts = rel.split('/')
    return parts.length >= 3 ? parts[1] : undefined
  }

  let mirrored = 0
  let unchanged = 0
  const skippedCarriers = []
  for (const file of source.files) {
    if (isCarrierPath(file.rel)) {
      skippedCarriers.push(file.rel)
      continue
    }
    const sessionId = sessionIdOf(file.rel)
    if (sessionId !== undefined && skipSessionIds.has(sessionId)) {
      targets.add(file.rel)
      skippedSessionIds.add(sessionId)
      continue
    }
    const target = path.join(mirrorRoot, ...file.rel.split('/'))
    targets.add(file.rel)
    const wrote = await writeIfDifferent(target, await fs.readFile(file.absolute))
    if (wrote) mirrored += 1
    else unchanged += 1
  }

  // 删除：默认保持既有行为；pull/status 可显式关闭删除，避免一个尚未
  // materialize 到 sessionRoot 的远端会话在下一次本地镜像时被误删。
  const deleted = []
  const forkedPreserved = []
  const carriersPreserved = []
  if (deps.deleteMissing !== false) {
    const targetFiles = []
    try {
      const walk = async (dir) => {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const absolute = path.join(dir, entry.name)
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) {
            await walk(absolute)
            continue
          }
          if (entry.isFile()) targetFiles.push(absolute)
        }
      }
      await walk(mirrorRoot)
    } catch {
      // 镜像根尚不存在 → 无删除可做。
    }
    for (const absolute of targetFiles) {
      const rel = path.relative(mirrorRoot, absolute).split(path.sep).join('/')
      const basename = path.posix.basename(rel)
      if (isCarrierPath(rel)) {
        carriersPreserved.push(rel)
        continue
      }
      const sessionId = sessionIdOf(rel)
      if (sessionId !== undefined && skipSessionIds.has(sessionId)) {
        skippedSessionIds.add(sessionId)
        continue
      }
      if (forkRe.test(basename)) {
        forkedPreserved.push(rel)
        continue
      }
      if (!targets.has(rel)) {
        await fs.unlink(absolute)
        deleted.push(rel)
      }
    }
  }

  return {
    mirrored,
    unchanged,
    skippedLinks: source.skipped,
    deleted,
    forkedPreserved,
    carriersPreserved,
    skippedCarriers,
    skippedSessionIds: [...skippedSessionIds].sort(),
  }
}

/**
 * Safely materialize the git worktree's session mirror back into sessionRoot.
 *
 * This is the reverse projection of mirrorSessionRoot, intentionally using
 * union/upsert semantics: it never deletes local sessions merely because the
 * remote lacks them, never restores fork carrier files, and can defer sessions
 * that the host reports as live/owned.
 */
export async function restoreMirrorToSessionRoot(deps) {
  const forkRe = deps.forkNameRe ?? FORK_NAME_RE
  const mirrorRoot = path.join(deps.repoDir, deps.mirrorDir)
  let source
  try {
    source = await listFiles(mirrorRoot)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') {
      return {
        restored: 0,
        unchanged: 0,
        restoredSessionIds: [],
        availableSessionIds: [],
        deferredSessionIds: [],
        deferred: [],
        skippedForks: [],
        skippedCarriers: [],
        skippedLinks: [],
        skippedTargetLinks: [],
      }
    }
    throw error
  }

  let restored = 0
  let unchanged = 0
  const restoredSessionIds = new Set()
  const availableSessionIds = new Set()
  const deferredSessionIds = new Set()
  const deferred = []
  const skippedForks = []
  const skippedCarriers = []
  const skippedTargetLinks = []
  const decisions = new Map()

  const sessionIdOf = (rel) => {
    const parts = rel.split('/')
    return parts.length >= 3 ? parts[1] : undefined
  }

  const targetHasSymlink = async (rel) => {
    let current = deps.sessionRoot
    for (const segment of rel.split('/')) {
      current = path.join(current, segment)
      try {
        const info = await fs.lstat(current)
        if (info.isSymbolicLink()) return true
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return false
        throw error
      }
    }
    return false
  }

  const writeAtomicIfDifferent = async (target, content) => {
    try {
      const existing = await fs.readFile(target)
      if (existing.equals(content)) return false
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') throw error
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.dsh-session-sync-${process.pid}.tmp`
    await fs.rm(temporary, { force: true })
    await fs.writeFile(temporary, content, { mode: 0o600 })
    try {
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    return true
  }

  for (const file of source.files) {
    if (isCarrierPath(file.rel)) {
      skippedCarriers.push(file.rel)
      continue
    }
    const basename = path.posix.basename(file.rel)
    if (forkRe.test(basename)) {
      skippedForks.push(file.rel)
      continue
    }

    const sessionId = sessionIdOf(file.rel)
    if (sessionId !== undefined && deps.shouldRestoreSession !== undefined) {
      let allowed = decisions.get(sessionId)
      if (allowed === undefined) {
        allowed = await deps.shouldRestoreSession(sessionId)
        decisions.set(sessionId, allowed)
      }
      if (!allowed) {
        deferred.push(file.rel)
        deferredSessionIds.add(sessionId)
        continue
      }
    }

    if (await targetHasSymlink(file.rel)) {
      skippedTargetLinks.push(file.rel)
      continue
    }

    const target = path.join(deps.sessionRoot, ...file.rel.split('/'))
    const wrote = await writeAtomicIfDifferent(target, await fs.readFile(file.absolute))
    if (wrote) {
      restored += 1
      if (sessionId !== undefined) restoredSessionIds.add(sessionId)
    } else {
      unchanged += 1
    }
    if (sessionId !== undefined) availableSessionIds.add(sessionId)
  }

  return {
    restored,
    unchanged,
    restoredSessionIds: [...restoredSessionIds],
    availableSessionIds: [...availableSessionIds],
    deferredSessionIds: [...deferredSessionIds],
    deferred,
    skippedForks,
    skippedCarriers,
    skippedLinks: source.skipped,
    skippedTargetLinks,
  }
}

/**
 * 确保设备身份文件内容为 deviceId（不同才写；返回是否写入）。
 * @param {string} repoDir - 同步仓库根。
 * @param {string} deviceFile - 文件名（repoDir 直下）。
 * @param {string} deviceId - 设备 id。
 * @returns {Promise<boolean>} 是否写入。
 */
export async function ensureDeviceFile(repoDir, deviceFile, deviceId) {
  const target = path.join(repoDir, deviceFile)
  const content = Buffer.from(`${deviceId}\n`)
  return writeIfDifferent(target, content)
}
