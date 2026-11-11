# Contributing to Osm Go!

Thank you for helping improve Osm Go!. Useful project links:

- [repository](https://github.com/DoFabien/OsmGo);
- [issues](https://github.com/DoFabien/OsmGo/issues);
- [releases](https://github.com/DoFabien/OsmGo/releases);
- [security policy](SECURITY.md);
- [user documentation](https://github.com/DoFabien/OsmGo/wiki).

## Translations

The interface is written in English (`src/assets/i18n/en.json`) and translated with an AI model. Every English text has a note for the translator in `i18n/en.context.json`: add or update it with the text. French is maintained with the code. [i18n/README.md](i18n/README.md) describes how to translate a language and the instructions given to the model; `npm run i18n -- check` validates the catalogs.

Some preset translations come from [iD Tagging Schema](https://github.com/openstreetmap/id-tagging-schema). Object descriptions come from the OpenStreetMap wiki through [Taginfo](https://taginfo.openstreetmap.org). Improve those descriptions on the related wiki item when the source text is incorrect.

## Supported development stack

The maintained stack is:

- Node.js 24.18.0 and npm 11.16.0;
- Angular 22.2 and Angular Material;
- Capacitor 8.6;
- MapLibre GL JS 6.17;
- JDK 21 and Android SDK 36 for Android builds.

Node is pinned in `.nvmrc`. Use npm and the committed `package-lock.json`; do not replace them with another package manager.

## Install and run

Start from the development branch:

```sh
git clone https://github.com/DoFabien/OsmGo.git
cd OsmGo
git switch develop
nvm install
nvm use
npm ci
npm run test:integration:install
```

Run the PWA locally:

```sh
npm run start
```

The production web build is written to `www/`:

```sh
npm run build
```

## Checks and tests

Biome checks TypeScript, JavaScript, JSON, and CSS. Prettier checks the remaining HTML, SCSS, Markdown, and YAML files. Angular uses Vitest for unit tests, while Playwright covers the critical PWA flows with local fixtures.

Run the same main checks as CI:

```sh
npm run check
npm run prettier:check
npm run test:ci
npm run test:scripts
npm run test:converter
npm run test:sprites
npm run build
npm run test:integration
npm audit --omit=dev
```

Tests must not write to the production OpenStreetMap API. HTTP, OAuth, map, and worker behavior in Playwright must use the local fixtures.

### Generated tags, presets, and sprites

The exact Name Suggestion Index and iD Tagging Schema versions are npm dependencies. No adjacent clone is needed for these imports.

```sh
npm run presets:generate
npm run update
```

`presets:generate` updates tags, fields, translations, and brands. `update` also refreshes sprites and basemaps. Commit every generated file changed by these commands. CI runs the generator twice, checks determinism, and rejects uncommitted generated output.

The vector background uses the OpenFreeMap tiles (OpenMapTiles schema, no API key). Its style, `src/assets/mapStyle/brigthCustom.json`, is generated from the OpenFreeMap "bright" style without points of interest, shields or remote fonts: download `https://tiles.openfreemap.org/styles/bright` and `https://tiles.openfreemap.org/planet`, then run `npm run basemap:style -- bright.json planet.json`. The second file becomes `src/assets/mapStyle/openfreemap-planet.json`, the TileJSON embedded in the app: the map uses the last TileJSON downloaded, or this copy, so the background opens offline.

The interface icons come from a subset of the Material Symbols Rounded font (`src/theme/material-symbols/`). After adding a new icon name in a template or component, run `npm run icons:subset` and commit the regenerated font: `npm run test:scripts` fails when an icon used in the sources is missing from the subset.

## Git workflow

Use small branches and keep each commit independently testable:

```text
fix/<topic> or chore/<topic> from develop
    -> pull request to develop

release/<version> from develop
    -> version, versionCode, changelog, and release notes only
    -> merge --no-ff to main
    -> tag <version>
    -> merge --no-ff main back to develop

hotfix/<version> from main
    -> fix and regression test
    -> merge to main and develop
```

Do not commit directly to `main`. Avoid direct commits to `develop`. Keep dependency updates, functional fixes, and mechanical formatting in separate commits.

## OpenStreetMap development server

Use the OSM development server for manual write tests. Never use automated write tests against OSM production.

Before switching servers, upload or discard every pending edit. Switching removes downloaded data, pending edits, and the current user session.

1. Open **Settings**.
2. Under **Developer mode**, enable **Use the OSM development server**.
3. Let the application reload and sign in with an account on the OSM development server.
4. Confirm that the send screen displays `DEV SERVER` before uploading.
5. Disable the setting to return to production; this clears the local working data again.

The PWA and Android application both use OAuth Authorization Code with PKCE. If a new callback URL is introduced, register it in the matching OSM OAuth application before testing.

## Web deployment

There is one host per environment:

- pushes to `develop` deploy only the development PWA to Cloudflare Pages and verify `https://dev.osmgo.com`;
- pushes to `main` deploy only the production PWA to Cloudflare Pages and verify `https://osmgo.com`.

Do not add a second production deployment workflow.

The protected `development` and `production` environments each use:

- variable `CLOUDFLARE_PAGES_PROJECT`;
- secret `CLOUDFLARE_ACCOUNT_ID`;
- secret `CLOUDFLARE_API_TOKEN`, limited to Cloudflare Pages edit access.

Set `CLOUDFLARE_PAGES_PROJECT` to the development project in the `development` environment and to the production project in the `production` environment. Keep the two custom domains and projects separate. Configure `develop` as the production branch of the development project and `main` as the production branch of the production project.

Each deployment publishes `build-info.json` with the application version and commit. Use it to verify a deployment and to identify the commit to revert.

## Android development

For local Android development, install JDK 21, Android SDK 36, and Android Studio. Synchronize a debug build and open it with:

```sh
npm run buildAndroidDebug
npm run android:studio
```

Attach Chrome or Edge to the WebView through `chrome://inspect` or `edge://inspect` when debugging on a device.

### Signed reference build in Docker

The Docker build is the reference release build. It pins Node, JDK, Android command-line tools, Build Tools, Bundletool, and uses the Gradle wrapper. Docker is the only host requirement for this path.

Keep the release keystore outside the repository. Put only the environment variables in the ignored `.env.android-signing` file and restrict its permissions:

```sh
chmod 600 .env.android-signing
set -a
. ./.env.android-signing
set +a
./scripts/build-android-docker.sh
```

The file must define:

```text
ANDROID_KEYSTORE_PATH=/absolute/path/outside/OsmGo/release.keystore
ANDROID_KEYSTORE_PASSWORD=...
ANDROID_KEY_ALIAS=...
ANDROID_KEY_PASSWORD=...
```

The keystore is mounted read-only under `/run/secrets/`; it is never copied into the image. The build fails if signing data is missing and verifies that secrets are absent from image metadata.

The verified output is exactly:

```text
dist/android/osmgo-<version>.apk
dist/android/osmgo-<version>.aab
dist/android/SHA256SUMS
dist/android/build-info.json
```

The APK is for direct installation. The AAB is for Google Play and is not directly installable. The verifier checks the application ID `fr.dogeo.osmgo`, version, versionCode, target SDK 36, checksums, APK alignment, APK/AAB signatures, and Bundletool validation.

## Preserve pending edits before reinstalling

Downloaded data and pending edits are stored locally. Uninstalling Android, clearing application storage, clearing browser site data, or switching OSM servers can permanently remove them.

Before any reinstall or storage reset:

1. open the send screen and check the pending item count;
2. confirm whether the app is connected to production or the development server;
3. upload the pending edits and confirm that the queue is empty;
4. only then update, uninstall, or clear storage.

There is currently no supported export/import for a pending queue. If an upload cannot be completed, stop and preserve the existing app or browser data while the problem is diagnosed. Installing a correctly signed update over the existing Android app should preserve storage; uninstalling it will not.

## Release and rollback

Create `release/X.Y.Z` from `develop`. A release branch contains only:

- `version` in `package.json`;
- a strictly increasing `VERSION_CODE` in `android/version.properties`, set to the current Unix time by `npm run android:version-code`;
- changelog and release notes.

Before merging, run the complete checks, build the signed Docker artifacts, compare the signing certificate SHA-256 fingerprint with the existing Play application, and test an upgrade from version 1.7.0 without losing pending data.

Merge the release branch to `main`, create the matching `X.Y.Z` tag, then merge `main` back into `develop`. The tag workflow builds the same signed artifacts and attaches the APK, AAB, checksums, and metadata to the GitHub Release. Upload the AAB to the Play internal track manually and validate the update before a progressive production rollout.

For a web rollback, revert the faulty commit on `main`; Cloudflare then deploys the reverted state. Merge the rollback back to `develop`. For Android, stop the Play rollout and publish a corrected patch with a higher `VERSION_CODE`. Do not reuse, move, or delete a published release tag, and do not attempt to roll back Play with an older AAB.

## Linux file watcher limit

If the local web server reports `ENOSPC: System limit for number of file watchers reached`, increase the host watcher limit according to your distribution's documentation. Avoid changing this system setting when the error is unrelated.
