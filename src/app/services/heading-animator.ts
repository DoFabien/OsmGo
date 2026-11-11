/** Signed shortest turn from `from` to `to`, in degrees, between -180 and 180. */
export const shortestTurn = (from: number, to: number): number =>
    ((((to - from) % 360) + 540) % 360) - 180

const normalizeBearing = (bearing: number): number =>
    ((bearing % 360) + 360) % 360

/** Share of the remaining gap kept from a compass reading: filters its noise. */
const SENSOR_SMOOTHING = 0.3
/** Time for the map to cover about two thirds of the remaining turn. */
const TURN_TIME_CONSTANT_MS = 120
/** Below this gap the map is considered aligned and the animation stops. */
const SETTLED_DEGREES = 0.2
/** A frame that took longer (tab in background) does not jump the map. */
const MAX_FRAME_MS = 100

export interface FrameScheduler {
    request(callback: (time: number) => void): number
    cancel(handle: number): void
}

/**
 * Turns the map toward the compass heading on every display frame. Raw
 * readings are noisy and arrive irregularly: applying each of them,
 * or a few per second, makes the map jerk. The readings are smoothed, then
 * the map eases toward them, always along the shortest way round.
 */
export class HeadingAnimator {
    private target: number | null = null
    private frame: number | null = null
    private lastFrameTime: number | null = null

    constructor(
        private readonly currentBearing: () => number,
        private readonly applyBearing: (bearing: number) => void,
        private readonly scheduler: FrameScheduler,
        /**
         * Checked on every frame: a frame requested before the camera was
         * taken by something else (a gesture, an animation, an unlocked
         * heading) must not turn the map, which would cut that movement short.
         */
        private readonly canApply: () => boolean = () => true
    ) {}

    /** A new compass reading, in degrees from north. */
    push(heading: number): void {
        this.target =
            this.target === null
                ? normalizeBearing(heading)
                : normalizeBearing(
                      this.target +
                          SENSOR_SMOOTHING * shortestTurn(this.target, heading)
                  )
        if (this.frame === null) {
            this.lastFrameTime = null
            this.frame = this.scheduler.request(this.step)
        }
    }

    /** Stops turning the map, for a gesture or when the heading is unlocked. */
    stop(): void {
        if (this.frame !== null) this.scheduler.cancel(this.frame)
        this.frame = null
        this.target = null
        this.lastFrameTime = null
    }

    private readonly step = (time: number): void => {
        this.frame = null
        if (this.target === null) return
        if (!this.canApply()) {
            this.stop()
            return
        }
        const elapsed =
            this.lastFrameTime === null
                ? 16
                : Math.min(time - this.lastFrameTime, MAX_FRAME_MS)
        this.lastFrameTime = time
        const current = this.currentBearing()
        const gap = shortestTurn(current, this.target)
        if (Math.abs(gap) < SETTLED_DEGREES) {
            if (gap !== 0) this.applyBearing(this.target)
            return
        }
        const share = 1 - Math.exp(-elapsed / TURN_TIME_CONSTANT_MS)
        this.applyBearing(normalizeBearing(current + gap * share))
        this.frame = this.scheduler.request(this.step)
    }
}
