import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { rootDir } from './_paths'

interface ServiceWorkerConfig {
    assetGroups: Array<{
        name: string
        resources: { files?: string[] }
    }>
    dataGroups?: Array<{
        name: string
        urls: string[]
        cacheConfig: {
            strategy: string
            maxSize: number
            maxAge: string
        }
    }>
}

interface GeneratedManifest {
    hashTable: Record<string, string>
    assetGroups: Array<{
        name: string
        urls: string[]
        cacheQueryOptions?: { ignoreSearch?: boolean }
    }>
    dataGroups: Array<{ name: string; patterns: string[] }>
}

const outputDirectory = path.join(rootDir, 'www')
const configPath = path.join(rootDir, 'ngsw-config.json')
const generatedManifestPath = path.join(outputDirectory, 'ngsw.json')
const config = JSON.parse(
    fs.readFileSync(configPath, 'utf8')
) as ServiceWorkerConfig
const generatedManifest = JSON.parse(
    fs.readFileSync(generatedManifestPath, 'utf8')
) as GeneratedManifest
const configSource = fs.readFileSync(configPath, 'utf8')

for (const stalePath of ['/assets/osmtogeojson.js', '/svg/md-']) {
    assert.ok(
        !configSource.includes(stalePath),
        `Stale service-worker path remains: ${stalePath}`
    )
}

const headersPath = path.join(outputDirectory, '_headers')
assert.ok(
    fs.existsSync(headersPath) &&
        fs.readFileSync(headersPath, 'utf8').includes('frame-ancestors'),
    'The build must include the Cloudflare Pages security headers'
)

const hasGlob = (filePath: string): boolean => /[*?!]/.test(filePath)
for (const group of config.assetGroups) {
    for (const filePath of group.resources.files ?? []) {
        if (hasGlob(filePath)) continue
        assert.ok(
            fs.existsSync(path.join(outputDirectory, filePath)),
            `${group.name} references missing build output ${filePath}`
        )
    }
}

for (const filePath of Object.keys(generatedManifest.hashTable)) {
    assert.ok(
        fs.existsSync(path.join(outputDirectory, filePath)),
        `Generated service-worker manifest references missing ${filePath}`
    )
}

const assetFiles = config.assetGroups.find((group) => group.name === 'assets')
    ?.resources.files
assert.ok(assetFiles?.includes('/assets/**'), 'Assets must use one broad glob')

const tilePolicy = config.dataGroups?.find(
    (group) => group.name === 'map-tiles-previously-viewed'
)
assert.deepEqual(tilePolicy?.cacheConfig, {
    maxSize: 800,
    maxAge: '15d',
    strategy: 'performance',
})

// The service worker routes a request to the first data group whose
// (unanchored) pattern matches: check where real basemap URLs end up.
const dataGroupOf = (url: string): string | undefined =>
    generatedManifest.dataGroups.find((group) =>
        group.patterns.some((pattern) => new RegExp(pattern).test(url))
    )?.name
assert.equal(
    dataGroupOf(
        'https://tiles.openfreemap.org/planet/20261101_080013_pt/14/8492/5872.pbf'
    ),
    'map-tiles-previously-viewed',
    'OpenFreeMap tiles must be cached as previously viewed tiles'
)
assert.equal(
    dataGroupOf('https://tiles.openfreemap.org/planet'),
    'basemap-tilejson',
    'The OpenFreeMap TileJSON must use its own freshness group'
)

// MapLibre loads its worker as maplibre-gl-worker.mjs?v=<version>: the
// prefetched copy is only served offline when the query is ignored.
const workerGroup = generatedManifest.assetGroups.find((group) =>
    group.urls.includes('/maplibre-gl-worker.mjs')
)
assert.ok(workerGroup, 'The MapLibre worker must be prefetched')
assert.equal(
    workerGroup.cacheQueryOptions?.ignoreSearch,
    true,
    'The MapLibre worker is requested with a query string: ignoreSearch is required'
)

console.log(
    `PWA build valid: ${Object.keys(generatedManifest.hashTable).length} hashed files and an explicit previously-viewed tile policy.`
)
