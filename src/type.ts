import type {
    Feature,
    FeatureCollection,
    Geometry,
    LineString,
    MultiLineString,
    MultiPoint,
    Point,
} from 'geojson'
import { Marker } from 'maplibre-gl'
import { MultiPolygon, Polygon } from 'martinez-polygon-clipping'

/**
 * Osm Go! specific geojson feature collection.

 */
export interface OsmGoFeatureCollection {
    type: 'FeatureCollection'
    features: OsmGoFeature[]
}

/**
 * Osm Go! specific geojson feature.
 *
 * Contains a specific set of features and any possible geometry.
 */
export type OsmGoFeature<G extends Geometry = Geometry> = Feature<
    G,
    FeatureProperties
> & {
    id: string | undefined
    members?: OsmRelationMember[]
    ndRefs?: Array<string | number>
}

export interface OsmRelationMember {
    type: 'node' | 'way' | 'relation'
    ref: string | number
    role: string
}

/**
 * Osm Go! specific geojson feature properties.
 */
export interface FeatureProperties {
    /** Display name derived from the OSM name or reference tag. */
    _name?: string
    /** Color of the marker as a hexadecimal string */
    hexColor: string
    /** Config marker icon or empty string. */
    icon: string
    id: number
    /** Identifier of the marker in the form "<shape>-<color>-<icon>" */
    marker: string
    /**
     * Meta information about the last change of the feature, e.g. timestamp and
     * author information.
     */
    meta: MetaData
    primaryTag: PrimaryTag
    tags: Record<string, string | number>
    type: string
    way_geometry?: Geometry
    /** Way IDs that use the node, or a legacy boolean cache value. */
    usedByWays?: boolean | string[]
    /**
     * Contains the original data of a feature in case it has been modified.
     * Needed to revert changes in case the user decides to undo her changes.
     */
    originalData?: OsmGoFeature | null
    /** Type of change by the user */
    changeType?: OsmGoChangeType
    configId?: string
    deprecated?: boolean
    fixme?: boolean
    mesure?: number
    relations?: unknown[]
    time?: number
    unknowTags?: boolean
}

/**
 * Identifier for any operation that changes the underlying geojson data of an
 * object.
 */
export type OsmGoChangeType = 'Create' | 'Update' | 'Delete'

export interface PrimaryTag {
    key: string
    value: string | number
}

interface MetaData {
    changeset: string
    timestamp: string
    uid: string
    user: string
    version: number
}

export interface Tag {
    key: string
    value: string | number
    isDefaultValue?: boolean
    preset?: Preset
    isJustAdded?: boolean
}

export interface PresetOption {
    lbl?: Record<string, string>
    v: string
    tags?: Record<string, string>
    countryCodes?: string[]
    excludeCountryCodes?: string[]
    terms?: Record<string, string | string[]>
}

export interface Preset {
    key?: string
    keys?: string[]
    lbl: Record<string, string>
    options?: PresetOption[]
    type: string
    iDtype?: string
    placeholder?: string
    snake_case?: boolean
    caseSensitive?: boolean
    customValues?: boolean
    _id: string
    optionsFromJson?: string
}

export interface TagConfig {
    key?: string
    icon: string
    markerColor: string
    presets: string[]
    lbl?: Record<string, string>
    terms?: Record<string, string | string[]>
    description?: Record<string, string>
    geometry: string[]
    iDRef?: string
    tags: Record<string, string | number>
    /** iD match score: how strongly the tags identify this category. */
    matchScore?: number
    /** Countries where the category applies; everywhere when missing. */
    countryCodes?: string[]
    /** Tags written in addition to `tags` when the category is chosen. */
    addTags?: Record<string, string | number>
    /** Tags that replace the object's tags when the category is chosen. */
    replace?: Record<string, string | number>
    moreFields?: string[]
    id: string
    isUserTag?: boolean
    deprecated?: boolean
    searchable?: boolean
    excludeCountryCodes?: string[]
}

export interface TapTagsJson {
    primaryKeys: string[]
    tags: TagConfig[]
}

export type TapPresetsJson = Record<string, Preset>

export interface Iso6391Language {
    code: string
    '639-2': string
    family: string
    name: string
    nativeName: string
    wikiUrl: string
}
export type Iso6391LanguageCodeJson = Record<string, Iso6391Language>

export type FeatureIdSource = 'data' | 'data_changed'

export type MapMode = 'Read' | 'Create' | 'Update' | 'Delete' // FIXME: @dotcs Is this valid?

export class OsmGoMarker<T = OsmGoFeature> extends Marker {
    declare id: string
    declare data: T
}

export type JsonSprites = Record<string, Sprite>

export interface Sprite {
    x: number
    y: number
    width: number
    height: number
    pixelRatio: number
}

/** List of tags as found in `src/assets/tagsAndPresets/tags.json` */
export interface TagsJson {
    primaryKeys: string[]
    tags: TagConfig[]
}

export interface CompassHeading {
    magneticHeading: number | null
    trueHeading: number | null
    headingAccuracy: number | null
    timestamp: number | null
}

export interface EventShowModal {
    type: MapMode
    geojson: OsmGoFeature
    newPosition?: boolean
    origineData: FeatureIdSource
    openPrimaryTagModalOnStart?: boolean
}

/**
 * ISO 3166-1 numeric and alpha-2 country codes of a country.
 *
 * See: https://www.iban.com/country-codes
 * See: https://en.wikipedia.org/wiki/ISO_3166-1_numeric
 */
export interface CountryCode {
    /** Human readable country name. */
    name: string
    /** Alpha-2 country code. */
    code: string
    /** Numeric ISO 3166-1 country code */
    'country-code': string
}
