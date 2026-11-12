import { AttributionControl, type AttributionControlOptions } from 'maplibre-gl'

/**
 * The map credits behind their (i) button on every screen: MapLibre shows
 * them unfolded until the first drag, over the map buttons on a phone.
 */
export class CollapsedAttributionControl extends AttributionControl {
    constructor(options: AttributionControlOptions = {}) {
        super({ ...options, compact: true })
        const updateCompact = this._updateCompact
        this._updateCompact = () => {
            const wasCompact =
                this._container?.classList.contains('maplibregl-compact')
            updateCompact()
            // folded once when the credits arrive; a tap still unfolds them
            if (!wasCompact) {
                this._container?.classList.remove('maplibregl-compact-show')
            }
        }
    }
}
