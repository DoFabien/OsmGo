const locks = (): LockManager | undefined => {
    try {
        return globalThis.navigator?.locks
    } catch {
        return undefined
    }
}

/**
 * Runs `task` while holding an exclusive Web Lock shared by every window of
 * the origin. Without the Web Locks API the task simply runs.
 */
export const withWebLock = <Result>(
    name: string,
    task: () => Promise<Result>
): Promise<Result> => {
    const manager = locks()
    return manager ? manager.request(name, task) : task()
}

/**
 * Tries to take an exclusive Web Lock without waiting. Resolves to a release
 * function, or `null` when another window holds the lock. Without the Web
 * Locks API there is nothing to coordinate: the release is a no-op.
 */
export const tryAcquireWebLock = (
    name: string
): Promise<(() => void) | null> => {
    const manager = locks()
    if (!manager) return Promise.resolve(() => undefined)
    return new Promise((resolve) => {
        void manager
            .request(name, { ifAvailable: true }, (lock) => {
                if (!lock) {
                    resolve(null)
                    return undefined
                }
                return new Promise<void>((release) => {
                    resolve(() => release())
                })
            })
            .catch(() => resolve(() => undefined))
    })
}
