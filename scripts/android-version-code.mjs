// Sets VERSION_CODE in android/version.properties to the current Unix time in
// seconds, as Osm Go! always did, but in a committed file so that every build
// of a release (local Docker or CI) carries the same code. Run it on the
// release branch: `npm run android:version-code`.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MAX_VERSION_CODE = 2_100_000_000
const propertiesPath = path.join(process.cwd(), 'android', 'version.properties')
const properties = readFileSync(propertiesPath, 'utf8')
const match = properties.match(/^VERSION_CODE=(\d+)$/m)
if (!match) {
    throw new Error(`${propertiesPath} must define VERSION_CODE.`)
}

const current = Number(match[1])
// The code must strictly increase, even if the clock is behind.
const next = Math.max(Math.floor(Date.now() / 1000), current + 1)
if (next > MAX_VERSION_CODE) {
    throw new Error(`VERSION_CODE ${next} exceeds the Play limit.`)
}

writeFileSync(
    propertiesPath,
    properties.replace(/^VERSION_CODE=\d+$/m, `VERSION_CODE=${next}`),
    'utf8'
)
console.log(`VERSION_CODE ${current} → ${next}`)
