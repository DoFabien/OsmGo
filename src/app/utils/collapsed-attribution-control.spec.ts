import type { Map as MapLibreMap } from 'maplibre-gl'
import { CollapsedAttributionControl } from './collapsed-attribution-control'

describe('CollapsedAttributionControl', () => {
    const createMap = (attribution: string, width: number) => {
        const canvasContainer = document.createElement('div')
        Object.defineProperty(canvasContainer, 'offsetWidth', {
            value: width,
        })
        return {
            getCanvasContainer: () => canvasContainer,
            on: vi.fn(),
            off: vi.fn(),
            style: {
                sourceCaches: {},
                stylesheet: { owner: undefined },
                tileManagers: {},
            },
            terrain: undefined,
            _getUIString: () => 'Toggle attribution',
            getStyle: () => ({}),
            attribution,
        } as unknown as MapLibreMap
    }

    it.each([
        ['a phone', 400],
        ['a wide screen', 1200],
    ])('keeps the credits folded on %s', (_label, width) => {
        const control = new CollapsedAttributionControl({
            customAttribution: '© OpenStreetMap',
        })

        const container = control.onAdd(createMap('', width))

        expect(container.classList).toContain('maplibregl-compact')
        expect(container.classList).not.toContain('maplibregl-compact-show')
        expect(container.textContent).toContain('© OpenStreetMap')
    })

    it('keeps the credits unfolded by a tap when the map resizes', () => {
        const control = new CollapsedAttributionControl({
            customAttribution: '© OpenStreetMap',
        })
        const container = control.onAdd(createMap('', 400))

        container.classList.add('maplibregl-compact-show')
        control._updateCompact()

        expect(container.classList).toContain('maplibregl-compact-show')
    })
})
