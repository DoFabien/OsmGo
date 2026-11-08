import { Location } from '@angular/common'
import { Injectable, inject } from '@angular/core'
import {
    type CanDeactivateFn,
    NavigationCancel,
    NavigationEnd,
    NavigationError,
    NavigationSkipped,
    type Params,
    ROUTER_CONFIGURATION,
    Router,
} from '@angular/router'
import { filter, firstValueFrom, race, timer } from 'rxjs'

const HISTORY_BACK_TIMEOUT_MS = 600
/** Query parameters that belong to an overlay, not to the map behind it. */
const OVERLAY_QUERY_PARAMS = { lng: null, lat: null }

export interface CloseableOverlay {
    canCloseOverlay?: () => boolean
}

/** Keeps a routed overlay on screen while it reports that it cannot be closed. */
export const overlayCanDeactivate: CanDeactivateFn<CloseableOverlay | null> = (
    overlay
) => {
    if (overlay?.canCloseOverlay?.() !== false) return true
    inject(OverlayNavigationService).onCloseRefused()
    return false
}

@Injectable({ providedIn: 'root' })
export class OverlayNavigationService {
    private readonly router = inject(Router)
    private readonly location = inject(Location)
    private readonly canceledNavigationResolution =
        inject(ROUTER_CONFIGURATION, { optional: true })
            ?.canceledNavigationResolution ?? 'replace'
    private pushedByApp = false

    async open(
        commands: string | readonly unknown[],
        queryParams?: Params
    ): Promise<boolean> {
        const normalizedCommands = Array.isArray(commands)
            ? commands
            : [commands]
        const urlBefore = this.router.url
        const navigated = await this.router.navigate(
            normalizedCommands,
            queryParams
                ? { queryParams, queryParamsHandling: 'merge' }
                : { queryParamsHandling: 'preserve' }
        )
        if (navigated && this.router.url !== urlBefore) {
            this.pushedByApp = true
        }
        return navigated
    }

    /**
     * Leaves the overlay by going back when the app pushed its history entry,
     * so that no duplicate map entry is left behind.
     */
    async close(): Promise<boolean> {
        if (this.pushedByApp) {
            this.pushedByApp = false
            const settled = this.nextNavigationSettled()
            this.location.back()
            await settled
            if (!this.isOverlayUrl(this.router.url)) return true
        }
        return this.router.navigate(['/'], {
            queryParams: OVERLAY_QUERY_PARAMS,
            queryParamsHandling: 'merge',
            replaceUrl: true,
        })
    }

    /**
     * Attaches the close guard to the overlay routes, so that browser history
     * navigation honours `canCloseOverlay`.
     */
    installCloseGuard(): void {
        const overlayRoutes =
            this.router.config.find(
                (route) => route.path === '' && route.children
            )?.children ?? []
        for (const route of overlayRoutes) {
            if (route.redirectTo !== undefined) continue
            const guards = route.canDeactivate ?? []
            if (!guards.includes(overlayCanDeactivate)) {
                route.canDeactivate = [...guards, overlayCanDeactivate]
            }
        }
    }

    onCloseRefused(): void {
        // Without the "computed" resolution, a refused history navigation
        // leaves the browser entry below the overlay rewritten.
        if (
            this.canceledNavigationResolution !== 'computed' &&
            this.router.getCurrentNavigation()?.trigger === 'popstate'
        ) {
            this.pushedByApp = false
        }
    }

    private isOverlayUrl(url: string): boolean {
        const path = url.split(/[?#]/)[0]
        return path !== '/' && path !== ''
    }

    private nextNavigationSettled(): Promise<unknown> {
        return firstValueFrom(
            race(
                this.router.events.pipe(
                    filter(
                        (event) =>
                            event instanceof NavigationEnd ||
                            event instanceof NavigationCancel ||
                            event instanceof NavigationError ||
                            event instanceof NavigationSkipped
                    )
                ),
                timer(HISTORY_BACK_TIMEOUT_MS)
            ),
            { defaultValue: undefined }
        )
    }
}
