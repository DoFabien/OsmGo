import type { OsmGoFeature } from '@osmgo/type'
import { featuresBbox, fitsInOneChangeset } from './changeset-bbox'

const feature = (geometry: object, wayGeometry?: object) =>
    ({
        type: 'Feature',
        geometry,
        properties: wayGeometry ? { way_geometry: wayGeometry } : {},
    }) as unknown as OsmGoFeature

describe('changeset bbox', () => {
    it('covers points and the full geometry of ways', () => {
        expect(
            featuresBbox([
                feature({ type: 'Point', coordinates: [2, 48] }),
                feature(
                    { type: 'Point', coordinates: [3, 49] },
                    {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [2.5, 47.5],
                                [3.5, 47.5],
                                [3.5, 49.5],
                                [2.5, 47.5],
                            ],
                        ],
                    }
                ),
            ])
        ).toEqual([2, 47.5, 3.5, 49.5])
        expect(featuresBbox([])).toBeUndefined()
    })

    it('accepts half a degree per side at most', () => {
        expect(fitsInOneChangeset([2, 48, 2.5, 48.5])).toBe(true)
        expect(fitsInOneChangeset([2, 48, 2.51, 48.1])).toBe(false)
    })
})
