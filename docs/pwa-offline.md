# PWA offline and update policy

The application shell and the interface translations are prefetched by
Angular's service worker when a release is installed, so a successfully opened
release can be reloaded without a network connection.

The generated assets (tag catalogs, sprites and icons under `/assets/**`) are
cached lazily: a file is only available offline after it was requested once.
Icons of presets that were never opened are therefore missing offline until
they have been displayed online.

Map tiles are different: the service worker keeps at most 800 tiles for 15
days with a cache-first strategy, for the default OpenFreeMap vector
background, the IGN BD ORTHO imagery (`data.geopf.fr`) and Bing aerial imagery.
The OpenFreeMap TileJSON, which names the current tile version, is embedded in
the style: the app uses the last TileJSON it downloaded (kept in its storage),
or a copy shipped with the release, and refreshes it in the background when
online. The vector background therefore opens offline, in the PWA and in the
Android app. Offline use
only includes tiles that were viewed previously; OsmGo does not download whole
basemaps for offline use. Other imagery providers are not cached.

When Angular reports `VERSION_READY`, the menu displays the update action. A
reload activates the new version. The Playwright PWA scenario installs a
release, exposes a second manifest, activates it and verifies another reload
while offline. `npm run pwa:validate:built` also rejects missing literal paths
and stale asset declarations in a built `www` directory.
