import { HttpClient } from '@angular/common/http'
import { inject, Service } from '@angular/core'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
import type { Feature, MultiPolygon, Polygon } from 'geojson'
import { defer, type Observable } from 'rxjs'
import { map, shareReplay } from 'rxjs/operators'

export interface Basemap {
    id: string
    name: string
    tiles: string[]
    scheme?: 'xyz' | 'tms'
    max_zoom?: number
    attribution?: { text?: string }
    [key: string]: unknown
}

@Service()
export class BasemapsService {
    private readonly http = inject(HttpClient)
    private readonly imagery$ = defer(() =>
        this.http.get<Array<Feature<Polygon | MultiPolygon, Basemap>>>(
            'assets/imagery.json'
        )
    ).pipe(shareReplay({ bufferSize: 1, refCount: false }))

    getBasemaps$(lng: number, lat: number): Observable<Basemap[]> {
        return this.imagery$.pipe(
            map((features) => {
                const result: Basemap[] = []
                const p = point([lng, lat])
                for (const feature of features) {
                    if (feature.geometry) {
                        if (booleanPointInPolygon(p, feature)) {
                            result.push(feature.properties)
                        }
                    } else {
                        result.push(feature.properties)
                    }
                }
                return result
            })
        )
    }

    // imagery.geojson
}
