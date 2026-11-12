#!/usr/bin/env node
/**
 * Generate the plugin-market index (format 1) for this bundle.
 *
 * The official market has no central registry: an index is a JSON file hosted on
 * any static site, and users paste its URL into Plugins → Discover. This script
 * keeps that file in sync with `package.json` instead of hand-editing versions.
 *
 * Usage:
 *   node scripts/market-index.mjs [--out site/index.json] [--timestamp <unix>]
 *   node scripts/market-index.mjs --check      # verify the existing index parses
 *                                              # and matches package.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function argOf(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const outputPath = join(root, argOf('--out', 'site/index.json'))
const checking = process.argv.includes('--check')

function isoHomepage(manifest) {
  const repository = manifest.repository
  const url = typeof repository === 'string' ? repository : repository?.url
  if (typeof url !== 'string') return undefined
  return `${url.replace(/\.git$/, '')}#readme`
}

function buildIndex(manifest, timestamp) {
  const homepage = isoHomepage(manifest)
  const engineRange = manifest.engines?.dsh
  const version = {
    version: manifest.version,
    publishTimestamp: timestamp,
    source: { type: 'npm' },
    ...(engineRange === undefined ? {} : { engines: { dsh: engineRange } }),
  }

  return {
    format: 1,
    title: { en: 'keelwatch', zh: 'keelwatch' },
    description: {
      en: 'Operations layer for a DSH plugin ecosystem: drift radar, failure brake, token attribution.',
      zh: 'DSH 插件生态运维层：依赖漂移雷达、失败刹车、Token 归因。',
    },
    plugins: [
      {
        name: manifest.name,
        title: { en: 'Keelwatch', zh: 'Keelwatch' },
        description: {
          en: 'Watches dependency drift, brakes repeatedly failing tools, and attributes tokens and latency per source.',
          zh: '看住依赖漂移、给反复失败的工具踩刹车、按来源归因 Token 与耗时。',
        },
        author: typeof manifest.author === 'string' ? manifest.author : undefined,
        ...(homepage === undefined ? {} : { homepage }),
        ...(typeof manifest.repository === 'object' && manifest.repository?.url
          ? { repository: { url: manifest.repository.url } }
          : {}),
        metadata: { keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [], labels: [], sortKeys: {} },
        versions: [version],
      },
    ],
  }
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const timestamp = Number(argOf('--timestamp', Math.floor(Date.now() / 1000)))

const index = buildIndex(manifest, timestamp)

if (checking) {
  let existing
  try {
    existing = JSON.parse(await readFile(outputPath, 'utf8'))
  } catch (error) {
    console.error(`market-index: cannot read ${outputPath}: ${error.message}`)
    process.exit(1)
  }
  const entry = existing.plugins?.find((plugin) => plugin.name === manifest.name)
  if (entry === undefined) {
    console.error(`market-index: ${outputPath} has no entry for ${manifest.name}`)
    process.exit(1)
  }
  const newest = entry.versions?.[0]
  const problems = []
  if (newest?.version !== manifest.version) problems.push(`version ${newest?.version} != package.json ${manifest.version}`)
  if (newest?.engines?.dsh !== manifest.engines?.dsh) {
    problems.push(`engines.dsh ${newest?.engines?.dsh} != package.json ${manifest.engines?.dsh}`)
  }
  if (problems.length > 0) {
    console.error(`market-index: ${outputPath} is stale:\n  - ${problems.join('\n  - ')}`)
    process.exit(1)
  }
  console.log(`market-index: ${outputPath} matches ${manifest.name}@${manifest.version}`)
  process.exit(0)
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`market-index: wrote ${outputPath} for ${manifest.name}@${manifest.version} (engines.dsh ${manifest.engines?.dsh})`)
