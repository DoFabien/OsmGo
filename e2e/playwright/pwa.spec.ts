import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'

const appUrl = '/?center=2.2945,48.8584&zoom=18'
const serviceWorkerManifestPath = path.join(process.cwd(), 'www', 'ngsw.json')

const emptyFeatureCollection = {
    type: 'FeatureCollection',
    features: [],
}

interface StoredOsmState {
    schemaVersion: 2
    revision: number
    officialById: Record<string, StoredFeature>
    pendingById: Record<string, StoredFeature>
    bbox: typeof emptyFeatureCollection
    nextTemporaryId: number
}

interface StoredOsmStateHead {
    pendingById: Record<string, StoredFeature>
    official: {
        slot: 'a' | 'b' | null
        delta: Record<string, StoredFeature | null>
    }
}

interface StoredFeature {
    id: string
    properties: {
        id: number
        tags: Record<string, string | number>
    }
    geometry: { coordinates: number[] }
}

const createStoredOsmState = (
    officialFeatures: StoredFeature[] = [],
    pendingFeatures: StoredFeature[] = []
): StoredOsmState => ({
    schemaVersion: 2,
    revision: 1,
    officialById: Object.fromEntries(
        officialFeatures.map((feature) => [feature.id, feature])
    ),
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

const changedPoi = {
    type: 'Feature',
    id: 'node/-1',
    properties: {
        id: -1,
        type: 'node',
        tags: { amenity: 'bench', name: 'Fixture bench' },
        meta: { timestamp: 0, version: 0, user: '' },
        changeType: 'Create',
        originalData: null,
        primaryTag: { key: 'amenity', value: 'bench' },
        _name: 'Fixture bench',
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
            tags: { amenity: 'bench', name: 'Downloaded bench' },
        },
    ],
})

async function mockExternalMapTiles(page: Page): Promise<void> {
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
    await mockExternalMapTiles(page)
    await page.goto(url)
    await expect(page.getByTestId('map')).toBeVisible()
    await expect(page.locator('.maplibregl-canvas')).toBeVisible()
}

async function requestServiceWorkerUpdate(page: Page): Promise<boolean> {
    return page.evaluate(
        () =>
            new Promise<boolean>((resolve, reject) => {
                const controller = navigator.serviceWorker.controller
                if (!controller) {
                    reject(
                        new Error('The page has no service-worker controller.')
                    )
                    return
                }
                const nonce = Math.round(Math.random() * 10_000_000)
                const timeout = window.setTimeout(() => {
                    navigator.serviceWorker.removeEventListener(
                        'message',
                        listener
                    )
                    reject(new Error('The service-worker update timed out.'))
                }, 15_000)
                const listener = (event: MessageEvent) => {
                    if (
                        event.data?.type !== 'OPERATION_COMPLETED' ||
                        event.data?.nonce !== nonce
                    ) {
                        return
                    }
                    window.clearTimeout(timeout)
                    navigator.serviceWorker.removeEventListener(
                        'message',
                        listener
                    )
                    if (event.data.error) {
                        reject(new Error(event.data.error))
                    } else {
                        resolve(Boolean(event.data.result))
                    }
                }
                navigator.serviceWorker.addEventListener('message', listener)
                controller.postMessage({
                    action: 'CHECK_FOR_UPDATES',
                    nonce,
                })
            })
    )
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
        const value = await new Promise((resolve, reject) => {
            result.onsuccess = () => resolve(result.result)
            result.onerror = () => reject(result.error)
        })
        database.close()
        return value
    }, key)
}

async function readOfficialFeatures(
    page: Page
): Promise<Record<string, StoredFeature>> {
    const head = await readStoredValue<StoredOsmStateHead | undefined>(
        page,
        'osmState'
    )
    if (!head) return {}
    const slot = head.official.slot
        ? await readStoredValue<
              { officialById: Record<string, StoredFeature> } | undefined
          >(page, `osmStateOfficial:${head.official.slot}`)
        : undefined
    const officialById = { ...(slot?.officialById ?? {}) }
    for (const [id, feature] of Object.entries(head.official.delta)) {
        if (feature === null) delete officialById[id]
        else officialById[id] = feature
    }
    return officialById
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

async function seedPendingChange(page: Page): Promise<void> {
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
            lastView: {
                lng: 2.2945,
                lat: 48.8584,
                zoom: 18,
                bearing: 0,
            },
        },
        osmState: createStoredOsmState([], [changedPoi]),
        user_info: {
            uid: '7',
            display_name: 'Fixture user',
            connected: true,
        },
        'osmToken:prod': 'fixture-token',
    })
    await page.reload()
    await expect(page.getByTestId('open-upload')).toBeVisible()
}

async function mockAuthenticatedUser(page: Page): Promise<void> {
    await page.route('**/api/0.6/user/details.json', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                user: { id: '7', display_name: 'Fixture user' },
            }),
        })
    )
}

async function panMap(
    page: Page,
    direction: 'ArrowLeft' | 'ArrowRight'
): Promise<number[]> {
    const initialCenter = new URL(page.url()).searchParams.get('center')
    const canvas = page.locator('.maplibregl-canvas')
    await canvas.focus()
    await page.keyboard.press(direction)
    await expect
        .poll(() => new URL(page.url()).searchParams.get('center'))
        .not.toBe(initialCenter)
    const center = new URL(page.url()).searchParams.get('center')
    if (!center) {
        throw new Error('The map center is missing from the URL.')
    }
    return center.split(',').map(Number)
}

test.describe('PWA installation', () => {
    test.use({ serviceWorkers: 'allow' })

    test('opens the production PWA locally', async ({ page }) => {
        await openApp(page)

        await expect(page).toHaveTitle('Osm Go!')
        const workerState = await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready
            return registration.active?.state
        })
        expect(workerState).toBe('activated')

        await page.reload()
        await expect
            .poll(() =>
                page.evaluate(() => Boolean(navigator.serviceWorker.controller))
            )
            .toBe(true)

        await page.context().setOffline(true)
        await page.reload()
        await expect(page).toHaveTitle('Osm Go!')
        await page.context().setOffline(false)
    })

    test('activates an upgrade and reloads the new version offline', async ({
        page,
    }) => {
        const originalManifest = fs.readFileSync(
            serviceWorkerManifestPath,
            'utf8'
        )

        try {
            await openApp(page)
            await page.reload()
            await expect
                .poll(() =>
                    page.evaluate(() =>
                        Boolean(navigator.serviceWorker.controller)
                    )
                )
                .toBe(true)

            const nextManifest = JSON.parse(originalManifest)
            nextManifest.appData = {
                ...(nextManifest.appData ?? {}),
                playwrightVersion: `${Date.now()}`,
            }
            fs.writeFileSync(
                serviceWorkerManifestPath,
                JSON.stringify(nextManifest)
            )

            await expect
                .poll(() => requestServiceWorkerUpdate(page), {
                    intervals: [500, 1_000, 2_000],
                    timeout: 30_000,
                })
                .toBe(true)
            await page.getByTestId('open-menu').click()
            const updateButton = page.getByRole('button', {
                name: /New version available!/,
            })
            await expect(updateButton).toBeVisible()
            await updateButton.click()
            await expect(page.getByTestId('map')).toBeVisible()

            await page.context().setOffline(true)
            await page.reload()
            await expect(page).toHaveTitle('Osm Go!')
            await expect(page.getByTestId('map')).toBeVisible()
        } finally {
            await page.context().setOffline(false)
            fs.writeFileSync(serviceWorkerManifestPath, originalManifest)
        }
    })
})

test('explains when WebGL 2 is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (...args) {
            if (args[0] === 'webgl2') {
                return null
            }
            return getContext.apply(this, args)
        }
    })

    await page.goto(appUrl)
    await expect(
        page.getByText('WebGL 2 is required to display the map on this device.')
    ).toBeVisible()
})

test('loads interface translations', async ({ page }) => {
    await openApp(page)
    await page.getByTestId('open-menu').click()

    await expect(page.getByText('Settings', { exact: true })).toBeVisible()
    await expect(page.getByText('MENU.SETTINGS', { exact: true })).toHaveCount(
        0
    )
})

test('keeps one unified feature sheet for details and raw OSM codes', async ({
    page,
}) => {
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

    const sheet = page.getByTestId('selected-object-sheet')
    await expect(page.getByTestId('edit-selected-poi')).toBeVisible()
    await expect(sheet.locator('.object-editor')).toHaveCount(0)
    const surveyCard = sheet.locator('survey-card .survey-card')
    const surveyQuestion = surveyCard.locator('.survey-card__question')
    const surveyActions = surveyCard.locator('.actions')
    await expect(
        surveyQuestion.getByText('Does this object still exist?', {
            exact: true,
        })
    ).toBeVisible()
    await expect(
        sheet.getByRole('button', { name: 'Yes', exact: true })
    ).toBeVisible()
    const surveyBox = await surveyCard.boundingBox()
    const questionBox = await surveyQuestion.boundingBox()
    const actionsBox = await surveyActions.boundingBox()
    expect(surveyBox?.height).toBeLessThanOrEqual(64)
    expect(
        Math.abs(
            (questionBox?.y ?? 0) +
                (questionBox?.height ?? 0) / 2 -
                ((actionsBox?.y ?? 0) + (actionsBox?.height ?? 0) / 2)
        )
    ).toBeLessThanOrEqual(2)

    const codeSwitch = sheet.getByRole('button', {
        name: 'Show or hide tag codes',
    })
    await expect(codeSwitch).toBeVisible()
    await expect(codeSwitch).toHaveAttribute('aria-pressed', 'false')
    await codeSwitch.click()

    await expect(sheet).toHaveAttribute('data-sheet-mode', 'read')
    await expect(codeSwitch).toHaveAttribute('aria-pressed', 'true')
    await expect(sheet.locator('.object-facts--code')).toBeVisible()
    await expect(
        sheet.locator('dt').filter({ hasText: 'amenity' })
    ).toBeVisible()
    await expect(sheet.locator('dt').filter({ hasText: 'name' })).toBeVisible()
    await expect(sheet.locator('.object-editor')).toHaveCount(0)
    await expect(page.getByTestId('edit-selected-poi')).toBeVisible()
})

test.describe('wide desktop category picker', () => {
    test.use({ viewport: { width: 1280, height: 720 } })

    test('keeps every control inside the object sheet', async ({ page }) => {
        await openApp(page)
        await page.getByTestId('add-poi').click()
        await page
            .getByRole('button', { name: 'Add an object', exact: true })
            .click()

        const sheet = page.getByTestId('selected-object-sheet')
        const search = page.getByPlaceholder('Search')
        const controls = [
            search,
            page.getByRole('radiogroup', { name: 'Category source' }),
            sheet.getByRole('button', { name: 'Cancel', exact: true }),
        ]
        const sheetBox = await sheet.boundingBox()
        expect(sheetBox).not.toBeNull()

        for (const control of controls) {
            await expect(control).toBeVisible()
            const controlBox = await control.boundingBox()
            expect(controlBox).not.toBeNull()
            expect(controlBox?.x).toBeGreaterThanOrEqual(sheetBox?.x ?? 0)
            expect(
                (controlBox?.x ?? 0) + (controlBox?.width ?? 0)
            ).toBeLessThanOrEqual((sheetBox?.x ?? 0) + (sheetBox?.width ?? 0))
        }

        await search.fill('bakery')
        const bakeryRow = page
            .locator('.tag-row')
            .filter({ hasText: 'shop=bakery' })
        await expect(bakeryRow).toHaveCount(1)
        await expect(bakeryRow.locator('.vectorIcon')).toHaveClass(
            /vectorIcon--loaded/
        )
        await expect(bakeryRow.locator('.svgIcon')).toHaveCSS('width', '34px')

        const addFavorite = bakeryRow.getByRole('button', {
            name: 'Add bookmark',
            exact: true,
        })
        await expect(addFavorite.locator('mat-icon')).toHaveText('favorite')
        await expect(addFavorite.locator('mat-icon')).toHaveCSS(
            'font-variation-settings',
            '"FILL" 1'
        )
        await addFavorite.click()
        const removeFavorite = bakeryRow.getByRole('button', {
            name: 'Remove bookmark',
            exact: true,
        })
        await expect(removeFavorite.locator('mat-icon')).toHaveText('favorite')
        await expect(removeFavorite).toHaveCSS('color', 'rgb(23, 103, 196)')
    })
})

test.describe('touch menu', () => {
    test.use({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 302, height: 416 },
    })

    test('navigates to settings', async ({ page }) => {
        await openApp(page)
        await page.getByTestId('open-menu').tap()
        await page.getByRole('button', { name: 'Settings', exact: true }).tap()

        await expect(page).toHaveURL((url) => url.pathname === '/settings')
        await expect(
            page.getByRole('heading', { name: 'Settings' })
        ).toBeVisible()
    })
})

test('downloads a small OSM area from a fixture', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 600 })
    await page.route('**/api/0.6/map?bbox=*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 800))
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: osmMapFixture,
        })
    })
    await openApp(page)

    const refreshButton = page.getByTestId('load-osm-data')
    const refreshLabel = refreshButton.locator('.refresh-button__label')
    await expect(refreshLabel).toHaveText('Refresh')
    await expect(refreshLabel).toBeVisible()
    await expect(refreshButton.locator('mat-icon')).toBeVisible()
    await expect(
        refreshButton.locator('.refresh-button__content')
    ).toBeVisible()
    await refreshButton.click()
    await expect(refreshButton.locator('mat-spinner')).toBeVisible()
    await refreshButton.locator('.refresh-button__label').evaluate((label) => {
        label.textContent =
            'Chargement des données cartographiques actuellement visibles'
    })
    const loadingLayout = await refreshButton.evaluate((button) => {
        const content = button.querySelector<HTMLElement>(
            '.refresh-button__content'
        )
        const spinner = button.querySelector<HTMLElement>('mat-spinner')
        const label = button.querySelector<HTMLElement>(
            '.refresh-button__label'
        )
        if (!content || !spinner || !label) return null
        const buttonRect = button.getBoundingClientRect()
        const contentRect = content.getBoundingClientRect()
        const spinnerRect = spinner.getBoundingClientRect()
        const labelRect = label.getBoundingClientRect()
        return {
            contentFitsButton:
                contentRect.left >= buttonRect.left &&
                contentRect.right <= buttonRect.right &&
                contentRect.top >= buttonRect.top &&
                contentRect.bottom <= buttonRect.bottom,
            centerDifference: Math.abs(
                spinnerRect.top +
                    spinnerRect.height / 2 -
                    (labelRect.top + labelRect.height / 2)
            ),
            labelWhiteSpace: getComputedStyle(label).whiteSpace,
        }
    })
    expect(loadingLayout).not.toBeNull()
    expect(loadingLayout?.contentFitsButton).toBe(true)
    expect(loadingLayout?.centerDifference).toBeLessThan(2)
    expect(loadingLayout?.labelWhiteSpace).toBe('nowrap')

    await expect
        .poll(async () => {
            const officialById = await readOfficialFeatures(page)
            return Boolean(officialById['node/1'])
        })
        .toBe(true)
})

test('stops loading when the OSM worker fails', async ({ page }) => {
    await page.route('**/worker-*.js', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: `self.onmessage = () => {
                    setTimeout(() => { throw new Error('Fixture worker failure') }, 100)
                }`,
        })
    )
    await page.route('**/api/0.6/map?bbox=*', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: osmMapFixture,
        })
    )
    await openApp(page)

    await page.getByTestId('load-osm-data').click()
    await expect(page.getByTestId('load-osm-data')).toBeVisible()
    await expect
        .poll(() => page.getByTestId('loading-osm-data').count())
        .toBe(0)
})

test('creates, edits, and persists a POI locally', async ({ page }) => {
    await page.route('**/worker-*.js', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: `self.onmessage = () => self.postMessage({
                ok: true,
                data: {
                    geojson: { type: 'FeatureCollection', features: [] },
                    geojsonBbox: { type: 'FeatureCollection', features: [] }
                }
            })`,
        })
    )
    await page.route('**/api/0.6/map?bbox=*', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                version: '0.6',
                bounds: {
                    minlat: 48.857,
                    minlon: 2.293,
                    maxlat: 48.86,
                    maxlon: 2.296,
                },
                elements: [],
            }),
        })
    )
    await page.route('**/api/0.6/node/-1.json', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                elements: [{ type: 'node', id: -1, lon: 2.2945, lat: 48.8584 }],
            }),
        })
    )
    const tags = encodeURIComponent(
        JSON.stringify({
            amenity: 'bench',
            material: 'wood',
            name: 'Created bench',
        })
    )
    await openApp(page, `/?center=2.2945,48.8584&zoom=18&add=${tags}`)

    const createButton = page.getByTestId('create-poi')
    await expect(createButton).toBeVisible()
    await expect(createButton).toBeEnabled()
    await createButton.click()
    await expect
        .poll(async () => {
            const osmState = await readStoredValue<StoredOsmState>(
                page,
                'osmState'
            )
            return Object.keys(osmState?.pendingById ?? {}).length
        })
        .toBe(1)

    await expect
        .poll(async () => {
            const savedFields = await readStoredValue<
                Record<
                    string,
                    { tags: Array<{ key: string; value: string | number }> }
                >
            >(page, 'savedFields')
            return savedFields?.['amenity/bench']?.tags.find(
                (tag) => tag.key === 'material'
            )?.value
        })
        .toBe('wood')

    await expect(page.getByTestId('selected-object-sheet')).toHaveCount(0)
    await page.getByTestId('add-poi').click()
    await page
        .getByRole('button', { name: 'Add an object', exact: true })
        .click()
    const lastBench = page
        .locator('.tag-row')
        .filter({ hasText: 'amenity=bench' })
    await expect(lastBench).toHaveCount(1)
    await lastBench.locator('.tag-row__main').click()
    const restoreLastAttributes = page.getByRole('button', {
        name: 'Reuse last fields · Bench',
        exact: true,
    })
    await expect(restoreLastAttributes).toBeVisible()
    await restoreLastAttributes.click()
    await page.getByRole('button', { name: 'Show or hide tag codes' }).click()
    await expect(page.getByLabel('material', { exact: true })).toHaveValue(
        'wood'
    )

    await page.goto('/?id=node/-1')
    await expect(page.getByTestId('edit-selected-poi')).toBeVisible()
    await page.getByTestId('edit-selected-poi').click()
    const nameInput = page.getByPlaceholder('Name')
    await nameInput.fill('Edited bench')
    await page.getByTestId('save-poi').click()

    await expect(page.getByTestId('selected-object-sheet')).toHaveCount(0)

    await expect
        .poll(async () => {
            const osmState = await readStoredValue<StoredOsmState>(
                page,
                'osmState'
            )
            return osmState?.pendingById['node/-1']?.properties.tags.name
        })
        .toBe('Edited bench')
})

test('uploads a pending change with fixture responses', async ({ page }) => {
    await mockAuthenticatedUser(page)
    await page.route('**/api/0.6/changeset/create', (route) =>
        route.fulfill({ status: 200, body: '123' })
    )
    await page.route('**/api/0.6/changeset/123/upload', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/xml',
            body: '<diffResult><node old_id="-1" new_id="100" new_version="1"/></diffResult>',
        })
    )
    await seedPendingChange(page)

    await page.getByTestId('open-upload').click()
    await page
        .getByPlaceholder('Changeset comment')
        .fill('Playwright fixture upload')
    await page.getByTestId('upload-changes').click()
    await expect(page).toHaveURL((url) => url.pathname === '/', {
        timeout: 10_000,
    })

    const osmState = await readStoredValue<StoredOsmState>(page, 'osmState')
    expect(Object.keys(osmState.pendingById)).toHaveLength(0)
    expect((await readOfficialFeatures(page))['node/100']).toBeDefined()
})

test('keeps the queue when changeset creation fails', async ({ page }) => {
    await mockAuthenticatedUser(page)
    await page.route('**/api/0.6/changeset/create', (route) =>
        route.fulfill({
            status: 500,
            contentType: 'text/plain',
            body: 'Fixture changeset failure',
        })
    )
    await seedPendingChange(page)

    await page.getByTestId('open-upload').click()
    await page
        .getByPlaceholder('Changeset comment')
        .fill('Failing fixture upload')
    await page.getByTestId('upload-changes').click()
    const uploadError = page.getByTestId('upload-error')
    await expect(uploadError).toContainText(
        'The changeset could not be prepared.'
    )
    await expect(uploadError.getByText('500', { exact: true })).toBeVisible()

    const osmState = await readStoredValue<StoredOsmState>(page, 'osmState')
    expect(Object.keys(osmState.pendingById)).toHaveLength(1)
})

test('accepts a valid OAuth callback and rejects an invalid state', async ({
    page,
}) => {
    let tokenRequests = 0
    await page.route('**/oauth2/token', async (route) => {
        tokenRequests++
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ access_token: 'callback-token' }),
        })
    })
    await mockAuthenticatedUser(page)
    await openApp(page)

    await page.evaluate(() => {
        sessionStorage.setItem(
            'osmOAuthTransaction:prod',
            JSON.stringify({
                state: 'expected-state',
                verifier: 'fixture-verifier',
                environment: 'prod',
                redirectUri: document.baseURI,
                createdAt: Date.now(),
            })
        )
    })
    await page.goto('/?code=fixture-code&state=expected-state')
    await expect.poll(() => tokenRequests).toBe(1)
    await expect
        .poll(() => readStoredValue(page, 'osmToken:prod'))
        .toBe('callback-token')
    await expect(page).not.toHaveURL(/code=|state=/)
    expect(
        await page.evaluate(() =>
            sessionStorage.getItem('osmOAuthTransaction:prod')
        )
    ).toBeNull()

    await page.evaluate(() => {
        sessionStorage.setItem(
            'osmOAuthTransaction:prod',
            JSON.stringify({
                state: 'expected-state',
                verifier: 'fixture-verifier',
                environment: 'prod',
                redirectUri: document.baseURI,
                createdAt: Date.now(),
            })
        )
    })
    await page.goto('/?code=fixture-code&state=wrong-state')
    await expect(page).not.toHaveURL(/code=|state=/)
    expect(tokenRequests).toBe(1)
    // A stray callback must not destroy the sign-in still in progress.
    expect(
        await page.evaluate(() =>
            sessionStorage.getItem('osmOAuthTransaction:prod')
        )
    ).not.toBeNull()
})

test('keeps the placement marker aligned at fixed map coordinates', async ({
    page,
}) => {
    await openApp(page)

    await page.getByTestId('add-poi').click()
    const mapBox = await page.getByTestId('map').boundingBox()
    const markerBox = await page.locator('.moveMarkerIcon').boundingBox()
    expect(mapBox).not.toBeNull()
    expect(markerBox).not.toBeNull()
    expect(markerBox!.x + markerBox!.width / 2).toBeCloseTo(
        mapBox!.x + mapBox!.width / 2,
        0
    )
    expect(markerBox!.y + markerBox!.height).toBeCloseTo(
        mapBox!.y + mapBox!.height / 2,
        0
    )
})

test('cancels and confirms moving an existing POI', async ({ page }) => {
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
    await page.getByTestId('edit-selected-poi').click()
    await page.getByTestId('move-poi').click()

    await expect(page.getByTestId('add-poi')).toHaveCount(0)
    await expect(page.getByTestId('center-on-gps')).toHaveCount(0)
    await expect(page.getByTestId('confirm-marker-move')).toBeVisible()
    await expect(page.getByTestId('cancel-marker-move')).toBeVisible()

    await panMap(page, 'ArrowRight')
    await page.getByTestId('cancel-marker-move').click()
    await expect(page.getByTestId('move-poi')).toBeVisible()

    const stateAfterCancel = await readStoredValue<StoredOsmState>(
        page,
        'osmState'
    )
    expect(Object.keys(stateAfterCancel.pendingById)).toHaveLength(0)
    const originalFeature = (await readOfficialFeatures(page))['node/1']
    expect(originalFeature?.geometry.coordinates).toEqual([2.2945, 48.8584])

    await page.getByTestId('move-poi').click()
    await expect
        .poll(() => new URL(page.url()).searchParams.get('center'))
        .toBe('2.2945,48.8584')
    const confirmedCoordinates = await panMap(page, 'ArrowLeft')
    await page.getByTestId('confirm-marker-move').click()
    await expect(page.getByTestId('save-poi')).toBeVisible()
    await page.getByTestId('save-poi').click()

    await expect
        .poll(async () => {
            const osmState = await readStoredValue<StoredOsmState>(
                page,
                'osmState'
            )
            return Boolean(osmState.pendingById['node/1'])
        })
        .toBe(true)
    const savedState = await readStoredValue<StoredOsmState>(page, 'osmState')
    const savedCoordinates =
        savedState.pendingById['node/1']?.geometry.coordinates
    expect(savedCoordinates).toBeDefined()
    expect(savedCoordinates?.[0]).toBeCloseTo(confirmedCoordinates[0], 6)
    expect(savedCoordinates?.[1]).toBeCloseTo(confirmedCoordinates[1], 6)
})

test('restores a pending queue after a page restart', async ({ page }) => {
    await seedPendingChange(page)
    await page.reload()

    await expect(page.getByTestId('open-upload')).toBeVisible()
    const osmState = await readStoredValue<StoredOsmState>(page, 'osmState')
    expect(Object.keys(osmState.pendingById)).toEqual(['node/-1'])
})
