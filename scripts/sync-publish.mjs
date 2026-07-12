#!/usr/bin/env node
// Vault -> content/ 選択同期。publish: true のノートと、そのノートが実際に埋め込み参照している
// アセットだけを content/ にコピーする。それ以外は物理的に content/ へ入らない。
//
// 使い方: node scripts/sync-publish.mjs [--vault <path>]
// 既定の Vault パスは環境変数 OBSIDIAN_VAULT_DIR、なければ下記 DEFAULT_VAULT_DIR。

import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const CONTENT_DIR = path.join(REPO_ROOT, "content")

const DEFAULT_VAULT_DIR = "C:\\Users\\amakk\\Documents\\Obsidian Vault"
const argVaultIdx = process.argv.indexOf("--vault")
const VAULT_DIR = path.resolve(
  argVaultIdx !== -1 ? process.argv[argVaultIdx + 1] : (process.env.OBSIDIAN_VAULT_DIR ?? DEFAULT_VAULT_DIR),
)

// Vault走査時にどの深さでも除外するディレクトリ名
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".obsidian",
  "node_modules",
  "dist",
  ".slidev",
  ".claude",
  ".vscode",
])

const ASSET_EXCLUDED_EXT = new Set([".md"]) // ノート埋め込み(トランスクルージョン)はコピーしない

function isExcludedDir(name) {
  return EXCLUDED_DIR_NAMES.has(name)
}

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue
      await walk(path.join(dir, entry.name), out)
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

function toPosix(p) {
  return p.split(path.sep).join("/")
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  try {
    return YAML.parse(match[1]) ?? {}
  } catch {
    return null
  }
}

/** Vault内の全ファイルを basename(小文字) -> [絶対パス...] / 相対パス(小文字) -> 絶対パス で索引化 */
function buildAssetIndex(allFiles) {
  const byBasename = new Map()
  const byRelPath = new Map()
  for (const abs of allFiles) {
    const rel = path.relative(VAULT_DIR, abs)
    const relPosix = toPosix(rel)
    byRelPath.set(relPosix.toLowerCase(), abs)
    const base = path.basename(abs).toLowerCase()
    if (!byBasename.has(base)) byBasename.set(base, [])
    byBasename.get(base).push(abs)
  }
  return { byBasename, byRelPath }
}

function extractEmbedRefs(body) {
  const refs = []
  // Obsidian wikilink embed: ![[target]] / ![[target|alias]] / ![[target#section]]
  const wikiRe = /!\[\[([^\]|#]+)[^\]]*\]\]/g
  let m
  while ((m = wikiRe.exec(body))) refs.push({ raw: m[1].trim(), kind: "wiki" })
  // Markdown embed: ![alt](target "title")
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  while ((m = mdRe.exec(body))) refs.push({ raw: decodeURIComponent(m[1].trim()), kind: "md" })
  return refs
}

/** 埋め込み参照を Vault 内の絶対パスへ解決する。解決不能なら null */
function resolveAssetRef(ref, noteAbsPath, index) {
  if (/^[a-z]+:\/\//i.test(ref.raw)) return null // 外部URL

  const candidates = []
  if (ref.kind === "wiki") {
    // shorthand: basename 一致で検索。ノートと同じディレクトリを優先。
    const base = path.basename(ref.raw).toLowerCase()
    const withExt = index.byBasename.get(base)
    if (withExt && withExt.length > 0) {
      const noteDir = path.dirname(noteAbsPath)
      const sameDir = withExt.find((p) => path.dirname(p) === noteDir)
      candidates.push(sameDir ?? withExt[0])
    } else {
      // 拡張子なしで書かれている場合、拡張子違いでの basename 前方一致を試す
      for (const [key, paths] of index.byBasename) {
        if (key.startsWith(base + ".")) {
          candidates.push(paths[0])
          break
        }
      }
    }
  } else {
    // markdown style: ノート相対 -> vault ルート相対 -> basename検索 の順
    const relToNote = path.resolve(path.dirname(noteAbsPath), ref.raw)
    const relToVault = path.resolve(VAULT_DIR, ref.raw.replace(/^\/+/, ""))
    candidates.push(relToNote, relToVault)
    const base = path.basename(ref.raw).toLowerCase()
    const byBase = index.byBasename.get(base)
    if (byBase) candidates.push(...byBase)
  }

  for (const c of candidates) {
    if (!c) continue
    const resolved = path.resolve(c)
    // Vault外への path traversal を拒否
    if (!resolved.startsWith(path.resolve(VAULT_DIR) + path.sep)) continue
    if (index.byRelPath.has(toPosix(path.relative(VAULT_DIR, resolved)).toLowerCase())) {
      return resolved
    }
  }
  return null
}

async function clearContentDir() {
  await fs.rm(CONTENT_DIR, { recursive: true, force: true })
  await fs.mkdir(CONTENT_DIR, { recursive: true })
}

async function copyFilePreservingRelPath(absSrc) {
  const rel = path.relative(VAULT_DIR, absSrc)
  const dest = path.join(CONTENT_DIR, rel)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(absSrc, dest)
  return rel
}

async function main() {
  console.log(`[sync-publish] Vault: ${VAULT_DIR}`)
  console.log(`[sync-publish] content/: ${CONTENT_DIR}`)

  const allFiles = await walk(VAULT_DIR)
  const mdFiles = allFiles.filter((f) => f.toLowerCase().endsWith(".md"))
  const index = buildAssetIndex(allFiles)

  const published = []
  for (const abs of mdFiles) {
    const raw = await fs.readFile(abs, "utf8")
    const fm = parseFrontmatter(raw)
    if (fm && fm.publish === true) {
      published.push({ abs, raw })
    }
  }

  await clearContentDir()

  const copiedAssets = new Set()
  const warnings = []
  let indexWritten = false

  for (const note of published) {
    const rel = await copyFilePreservingRelPath(note.abs)
    if (toPosix(rel) === "index.md") indexWritten = true

    const refs = extractEmbedRefs(note.raw)
    for (const ref of refs) {
      const resolved = resolveAssetRef(ref, note.abs, index)
      if (!resolved) {
        warnings.push(`  ! 未解決の埋め込み参照: "${ref.raw}" (${toPosix(rel)} 内)`)
        continue
      }
      if (ASSET_EXCLUDED_EXT.has(path.extname(resolved).toLowerCase())) {
        continue // ノート同士のトランスクルージョンはコピーしない
      }
      const assetRel = toPosix(path.relative(VAULT_DIR, resolved))
      if (copiedAssets.has(assetRel)) continue
      await copyFilePreservingRelPath(resolved)
      copiedAssets.add(assetRel)
    }
  }

  if (!indexWritten) {
    const links = published
      .map((n) => toPosix(path.relative(VAULT_DIR, n.abs)))
      .sort()
      .map((p) => `- [[${p.replace(/\.md$/, "")}]]`)
      .join("\n")
    const fallback = `---\ntitle: Bizarress Garden\npublish: true\n---\n\n${links || "(まだ公開ノートがありません)"}\n`
    await fs.writeFile(path.join(CONTENT_DIR, "index.md"), fallback, "utf8")
  }

  console.log(`[sync-publish] 公開ノート: ${published.length} 件`)
  console.log(`[sync-publish] コピーしたアセット: ${copiedAssets.size} 件`)
  if (warnings.length > 0) {
    console.log(`[sync-publish] 警告 ${warnings.length} 件:`)
    for (const w of warnings) console.log(w)
  }
}

main().catch((err) => {
  console.error("[sync-publish] 失敗:", err)
  process.exit(1)
})
