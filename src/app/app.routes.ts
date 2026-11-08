import { inject } from '@angular/core'
import { Router, type Routes } from '@angular/router'
import { MainPage } from '@components/main/main'

export const routes: Routes = [
    {
        path: '',
        component: MainPage,
        children: [
            { path: 'callback', pathMatch: 'full', redirectTo: '' },
            {
                path: 'about',
                data: { overlaySize: 'compact' },
                loadComponent: () =>
                    import('@components/about/about').then(
                        (module) => module.AboutPage
                    ),
            },
            {
                path: 'settings',
                data: { overlaySize: 'standard' },
                loadComponent: () =>
                    import('@components/settings/settings').then(
                        (module) => module.SettingsPage
                    ),
            },
            {
                path: 'pushData',
                data: { overlaySize: 'wide' },
                loadComponent: () =>
                    import('@components/pushDataToOsm/pushDataToOsm').then(
                        (module) => module.PushDataToOsmPage
                    ),
            },
            {
                path: 'tags',
                data: { overlaySize: 'standard' },
                loadComponent: () =>
                    import(
                        '@components/manage-tags/manage-tags.component'
                    ).then((module) => module.ManageTagsComponent),
            },
            {
                // Coordinates stay in the query: a last path segment with a dot
                // is served as a missing file when the page is reloaded.
                path: 'basemaps',
                data: { overlaySize: 'wide' },
                loadComponent: () =>
                    import('@components/basemaps/basemaps.component').then(
                        (module) => module.BasemapsComponent
                    ),
            },
            {
                path: 'basemaps/:lng/:lat',
                redirectTo: ({ params, queryParams }) =>
                    inject(Router).createUrlTree(['/basemaps'], {
                        queryParams: {
                            ...queryParams,
                            lng: params['lng'],
                            lat: params['lat'],
                        },
                    }),
            },
        ],
    },
    { path: '**', pathMatch: 'full', redirectTo: '' },
]
