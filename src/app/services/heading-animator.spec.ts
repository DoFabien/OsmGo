import { HeadingAnimator, shortestTurn } from './heading-animator'

const createAnimator = (startBearing = 0, canApply?: () => boolean) => {
    let bearing = startBearing
    const frames: Array<(time: number) => void> = []
    const applied: number[] = []
    const animator = new HeadingAnimator(
        () => bearing,
        (next) => {
            bearing = next
            applied.push(next)
        },
        {
            request: (callback) => frames.push(callback),
            cancel: (handle) => {
                frames[handle - 1] = () => undefined
            },
        },
        canApply
    )
    let time = 0
    /** Runs the pending frames, 16 ms apart, until none is requested. */
    const runFrames = (max = 500) => {
        for (let count = 0; count < max && frames.length > 0; count++) {
            time += 16
            frames.shift()?.(time)
        }
    }
    return { animator, applied, bearing: () => bearing, frames, runFrames }
}

describe('HeadingAnimator', () => {
    it('measures turns the short way round north', () => {
        expect(shortestTurn(359, 1)).toBe(2)
        expect(shortestTurn(1, 359)).toBe(-2)
        expect(shortestTurn(90, 270)).toBe(-180)
    })

    it('eases the map toward the heading in many small steps', () => {
        const { animator, applied, bearing, runFrames } = createAnimator()

        animator.push(90)
        runFrames()

        expect(applied.length).toBeGreaterThan(10)
        expect(
            Math.max(
                ...applied
                    .slice(0, -1)
                    .map((value, index) => Math.abs(applied[index + 1] - value))
            )
        ).toBeLessThan(15)
        expect(bearing()).toBeCloseTo(90, 0)
    })

    it('turns across north instead of the long way', () => {
        const { animator, applied, runFrames } = createAnimator(350)

        animator.push(10)
        runFrames()

        expect(applied.every((value) => value >= 350 || value <= 10)).toBe(true)
    })

    it('smooths a noisy reading instead of following it at once', () => {
        const { animator, runFrames, bearing } = createAnimator()
        animator.push(0)
        runFrames()

        animator.push(30)
        runFrames()

        expect(bearing()).toBeGreaterThan(5)
        expect(bearing()).toBeLessThan(15)
    })

    it('stops requesting frames once aligned, and when stopped', () => {
        const { animator, frames, runFrames } = createAnimator()
        animator.push(40)
        runFrames()
        expect(frames).toHaveLength(0)

        animator.push(80)
        animator.stop()
        const before = frames.length
        runFrames()
        expect(before).toBe(1)
    })

    it('drops a pending frame once the camera belongs to something else', () => {
        let cameraIsFree = true
        const { animator, applied, frames, runFrames } = createAnimator(
            0,
            () => cameraIsFree
        )
        animator.push(90)
        // e.g. "reset north" starts its animation before the frame runs
        cameraIsFree = false
        runFrames()

        expect(applied).toEqual([])
        expect(frames).toHaveLength(0)

        cameraIsFree = true
        animator.push(90)
        runFrames()
        expect(applied.length).toBeGreaterThan(0)
    })
})
