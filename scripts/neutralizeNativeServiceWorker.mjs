import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The Android app is served from https://localhost, the same origin as the V1
// app, whose Angular service worker is still registered in existing installs
// and keeps serving the V1 files from its cache. A worker published at the
// same URL replaces it: it takes control of the open pages, removes the
// caches, unregisters itself and reloads the pages, which then load the V2
// files from the APK.
const [, , outputDirectoryArgument = 'www'] = process.argv
const outputDirectory = path.resolve(outputDirectoryArgument)

if (!existsSync(path.join(outputDirectory, 'index.html'))) {
    throw new Error(`No web build found in ${outputDirectory}`)
}

const neutralizingWorker = `self.addEventListener('install', () => {
    self.skipWaiting()
})

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            await self.clients.claim()
            const cacheNames = await caches.keys()
            await Promise.all(cacheNames.map((name) => caches.delete(name)))
            await self.registration.unregister()
            const windows = await self.clients.matchAll({ type: 'window' })
            await Promise.all(
                windows.map((client) => client.navigate(client.url).catch(() => undefined))
            )
        })()
    )
})
`

writeFileSync(path.join(outputDirectory, 'ngsw-worker.js'), neutralizingWorker)
rmSync(path.join(outputDirectory, 'safety-worker.js'), { force: true })
rmSync(path.join(outputDirectory, 'ngsw.json'), { force: true })
