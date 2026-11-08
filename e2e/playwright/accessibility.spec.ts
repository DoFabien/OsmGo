import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

const appUrl = '/?center=2.2945,48.8584&zoom=18'

const emptyFeatureCollection = {
    type: 'FeatureCollection',
    features: [],
}

const storedOsmState = (
    pendingFeatures: Array<{ id: string; properties: { id: number } }>
) => ({
    schemaVersion: 2,
    revision: 1,
    officialById: {},
    pendingById: Object.fromEntries(
        pendingFeatures.map((feature) => [feature.id, feature])
    ),
    bbox: emptyFeatureCollection,
    nextTemporaryId:
        Math.min(
            -1,
            ...pendingFeatures.map((feature) => feature.properties.id)
        ) - 1,
})

const pendingFeature = {
    type: 'Feature',
    id: 'node/-1',
    properties: {
        id: -1,
        type: 'node',
        tags: { amenity: 'bench', name: 'Accessible bench' },
        changeType: 'Create',
        meta: {
            changeset: '1',
            timestamp: '2026-08-01T10:00:00Z',
            uid: '7',
            user: 'Fixture user',
            version: 0,
        },
        primaryTag: { key: 'amenity', value: 'bench' },
        _name: 'Accessible bench',
        marker: 'circle-amenity_bench',
        icon: 'maki-bench',
        hexColor: '#6b7c31',
    },
    geometry: {
        type: 'Point',
        coordinates: [2.2945, 48.8584],
    },
}

const osmMapFixture = JSON.stringify({
    version: '0.6',
    generator: 'Playwright',
    bounds: {
        minlat: 48.857,
        minlon: 2.293,
        maxlat: 48.86,
        maxlon: 2.296,
    },
    elements: [
        {
            type: 'node',
            id: 1,
            lat: 48.8584,
            lon: 2.2945,
            version: 1,
            timestamp: '2026-08-01T10:00:00Z',
            uid: 7,
            user: 'Fixture user',
            tags: { amenity: 'bench', name: 'Accessible bench' },
        },
    ],
})

async function mockMapTiles(page: Page): Promise<void> {
    await page.route('https://tiles.openfreemap.org/planet', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                tilejson: '3.0.0',
                tiles: [
                    'https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf',
                ],
                minzoom: 0,
                maxzoom: 14,
            }),
        })
    )
    await page.route(/https:\/\/tiles\.openfreemap\.org\/planet\/.*/, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/x-protobuf',
            body: Buffer.alloc(0),
        })
    )
}

async function openApp(page: Page, url = appUrl): Promise<void> {
    await mockMapTiles(page)
    await page.goto(url)
    await expect(page.getByTestId('map')).toBeVisible()
    await expect(page.locator('.maplibregl-canvas')).toBeVisible()
}

async function readStoredValue<T>(page: Page, key: string): Promise<T> {
    return page.evaluate(async (storageKey) => {
        const request = indexedDB.open('_ionicstorage')
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const transaction = database.transaction('_ionickv', 'readonly')
        const result = transaction.objectStore('_ionickv').get(storageKey)
        const value = await new Promise<T>((resolve, reject) => {
            result.onsuccess = () => resolve(result.result)
            result.onerror = () => reject(result.error)
        })
        database.close()
        return value
    }, key)
}

async function writeStoredValues(
    page: Page,
    values: Record<string, unknown>
): Promise<void> {
    await page.evaluate(async (storageValues) => {
        const request = indexedDB.open('_ionicstorage')
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const transaction = database.transaction('_ionickv', 'readwrite')
        const store = transaction.objectStore('_ionickv')
        for (const [key, value] of Object.entries(storageValues)) {
            store.put(value, key)
        }
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
        })
        database.close()
    }, values)
}

async function seedPendingFeature(page: Page): Promise<void> {
    await openApp(page)
    const config = await readStoredValue<Record<string, unknown>>(
        page,
        'config'
    )

    await writeStoredValues(page, {
        config: {
            ...config,
            centerWhenGpsIsReady: false,
            languageUi: 'en',
            languageTags: 'en',
        },
        osmState: storedOsmState([pendingFeature]),
        user_info: {
            uid: '7',
            display_name: 'Fixture user',
            connected: true,
        },
        'osmToken:prod': 'fixture-token',
    })
}

async function openStoredFeature(page: Page): Promise<void> {
    await page.route('**/api/0.6/node/1.json', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                elements: [
                    {
                        type: 'node',
                        id: 1,
                        lon: 2.2945,
                        lat: 48.8584,
                    },
                ],
            }),
        })
    )
    await page.route('**/api/0.6/map?bbox=*', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: osmMapFixture,
        })
    )
    await openApp(page, `${appUrl}&id=node/1&loadData=true`)
    await expect(page.getByTestId('edit-selected-poi')).toBeVisible()
}

async function expectAccessible(page: Page, context: string): Promise<void> {
    await page.evaluate(async () => {
        const animations = [
            ...document.querySelectorAll('.mat-mdc-snack-bar-container'),
        ].flatMap((element) => element.getAnimations())
        await Promise.allSettled(
            animations.map((animation) => animation.finished)
        )
    })
    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    const details = results.violations
        .map(
            (violation) =>
                `${violation.id}: ${violation.help} (${violation.nodes.length} node(s))\n${violation.nodes.map((node) => `${node.target.join(' > ')}\n${node.failureSummary ?? ''}`).join('\n')}`
        )
        .join('\n')

    expect(details, context).toBe('')
}

test('map passes WCAG AA checks', async ({ page }) => {
    await openApp(page)

    await expectAccessible(page, 'Map')
})

test('menu passes WCAG AA checks', async ({ page }) => {
    await openApp(page)
    await page.getByTestId('open-menu').click()
    await expect(page.locator('#menu')).toBeVisible()

    await expectAccessible(page, 'Menu')
})

test('feature reading passes WCAG AA checks', async ({ page }) => {
    await openStoredFeature(page)

    await expectAccessible(page, 'Feature reading')
})

test('feature editing passes WCAG AA checks', async ({ page }) => {
    await openStoredFeature(page)
    await page.getByTestId('edit-selected-poi').click()
    await expect(page.getByTestId('save-poi')).toBeVisible()

    await expectAccessible(page, 'Feature editing')
})

test('settings pass WCAG AA checks', async ({ page }) => {
    await openApp(page)
    await page.getByTestId('open-menu').click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    await expectAccessible(page, 'Settings')
})

test('upload passes WCAG AA checks', async ({ page }) => {
    await seedPendingFeature(page)
    await page.goto(appUrl)
    await expect(page.getByTestId('open-upload')).toBeVisible()
    await page.getByTestId('open-upload').click()
    await expect(page.getByTestId('upload-changes')).toBeVisible()

    await expectAccessible(page, 'Upload')
})
