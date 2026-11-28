# @satee/openfeature-provider

An [OpenFeature](https://openfeature.dev) provider for reading Satee feature flags in Node.

## Install

```sh
npm install @openfeature/server-sdk @satee/openfeature-provider
```

`@openfeature/server-sdk` is a peer dependency, so install it alongside the provider.

## Use

Set `SATEE_SDK_KEY` to the key from the Setup page in Satee, then, in an ES module:

```js
import { OpenFeature } from "@openfeature/server-sdk";
import { SateeProvider } from "@satee/openfeature-provider";

const sdkKey = process.env.SATEE_SDK_KEY;
await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey }));

const flags = OpenFeature.getClient();
const on = await flags.getBooleanValue("new-checkout", false);
```

Every Satee flag is boolean. Reading a flag is a lookup in memory and never waits on the network.

[`examples/`](examples) has runnable versions of this snippet, of event handlers, and of shutting down on `SIGTERM`.

## Options

| Option           | Default                          | Meaning                                                                                            |
| ---------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `sdkKey`         | required                         | the server key from the Setup page, with its `satee_server_` prefix                                |
| `pollIntervalMs` | `5000`                           | time between polls; values below `1000` are raised to `1000`, and `NaN` or `Infinity` means `5000` |
| `baseUrl`        | `https://flags.satee.dev`        | another host, such as a local server in tests                                                      |
| `logger`         | warnings and errors to `console` | an object with `debug`, `info`, `warn` and `error`                                                 |

The SDK key is for server code only. Never ship it in browser code: anyone who has it can read every flag.

A missing key, or one that is not `satee_server_` followed by the 24-character secret, throws from the constructor, and so
does a browser key (`satee_client_`). That is the only time the provider throws: a wrong key is a deployment mistake,
and it is best caught at start.

## How it behaves

The provider downloads your flag file at start and then checks it every `pollIntervalMs`. A check that finds no
change costs one small request. A change made in Satee reaches the file about a second later, so the poll interval
is what your app waits for.

- **At start**, `setProviderAndWait` resolves as soon as the first file loads, trying once a second for up to 5
  seconds. A `404` or `403` ends the wait at once. It never rejects.
- **When flags change**, the provider swaps in the new set at once and emits `ConfigurationChanged` with the keys of
  the flags that changed. An evaluation sees the old set or the new one, never a mix.
- **A file that fails its checks** is ignored, and the flags already loaded stay in place. That includes broken JSON,
  a flag whose default is not one of its variants, an older revision, targeting rules, and a file over 4 MiB. Each
  such file is logged once as a warning, and it counts as a failed poll.
- **A flag that is not in the file** returns the default you passed, with the error code `FLAG_NOT_FOUND`. Asking for
  a flag as anything other than a boolean returns your default with `TYPE_MISMATCH`.

### When Satee cannot be reached

The provider keeps serving the last good flags it has, keeps trying, and tells you through events. Each problem is
reported once, when it starts, not on every failed poll.

- **Nothing loaded within 5 seconds of start**: `setProviderAndWait` resolves anyway. The SDK emits `Ready` as it
  resolves, and the provider emits `Error` with "Could not load flags yet" straight after. Every flag returns the
  default you passed, with `PROVIDER_NOT_READY`. Polling carries on at the normal interval. Until that `Error`
  arrives, on the tick after the `await`, `providerStatus` still reads `READY`, so check for the `Error` event or
  evaluate a flag rather than reading the status. A handler added after the failure gets the SDK's replay of the
  `Error`, without the message.
- **No successful poll for 60 seconds** after flags were loaded: on the first failed poll 60 seconds or more after the
  last successful one, the provider emits `Stale` with "Could not refresh flags; serving the last good values", and
  keeps serving them. It does not emit `Stale` while an `Error` is already reported.
- **The key is not found (`404`)**: the provider emits `Error` with "SDK key not found. Check SATEE_SDK_KEY." if no
  flags were loaded yet, or "SDK key no longer valid" if they were. Loaded flags keep being served; with none, every
  flag returns `PROVIDER_NOT_READY`. Polling slows to once a minute, or to `pollIntervalMs` if that is longer.
- **The request is refused (`403`)**: the same, with "Request refused (403). Check SATEE_SDK_KEY and the base URL." A
  firewall between your app and Satee can also cause this.
- **Any successful poll** afterwards, including one that finds no change, emits `Ready` and returns polling to the
  normal interval.

The provider never enters the fatal state, so a key that starts working again needs no restart.

It logs each `Error` at `error`, each `Stale` and each ignored file at `warn`, a recovery at `info`, and every other
failed poll at `debug`. The default logger prints only warnings and errors. Log lines name a key by its last four
characters and never include the key or the file URL.

[`examples/events.js`](examples/events.js) shows a handler for each of these events.

## Node support

Node 22.12 or later. The package is ESM only, and CommonJS can load it with `require()`.

## TypeScript

The package ships its own types for TypeScript 5.8 or later, and they pass with `"strict": true` and
`"skipLibCheck": false`. CI type-checks these settings with TypeScript 5.8 and the latest TypeScript, against the
lowest and the latest `@openfeature/server-sdk` the peer range allows:

- `"module": "nodenext"`, from an ES module, top-level `await` included.
- `"module": "nodenext"`, from CommonJS (a `.cts` file). TypeScript 5.7 and earlier refuse to import an ES module
  from CommonJS, and so does `"module": "node16"` on any version.
- `"moduleResolution": "bundler"`.

`"moduleResolution": "node10"` (the old `"node"`) cannot see the package's `exports` and is not supported.

## Reading the file directly

The provider reads one JSON file per key, in the [flagd](https://flagd.dev) flag format, without targeting rules. The
URL holds a hash of the key, never the key itself: the first 32 hex characters of the SHA-256 of `satee-flags-v1:`
followed by the key without its `satee_server_` prefix. `/v1/` is the version of the file format. To see what your app
gets, copy the flag file URL from the Setup page in Satee:

```sh
curl "<flag file URL from the Setup page>"
```

Or build the URL from the key:

```sh
KEY="${SATEE_SDK_KEY#satee_server_}"
curl "https://flags.satee.dev/v1/$(printf 'satee-flags-v1:%s' "$KEY" | shasum -a 256 | cut -c1-32)/flags.json"
```

## Development

CI runs these commands in this order. Run them the same way before opening a pull request:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run examples
node -e 'require("./dist/index.js")'
npm pack --dry-run
npm run check:types
npm run check:consumers
```

`npm run format` fixes formatting and safe lint findings in place. Node versions before 22.18 need
`NODE_OPTIONS=--experimental-strip-types` to run the tests, the examples and `check:live`.

`npm run check:live` reads a real file from `https://flags.satee.dev` and checks that the
provider serves it. Set `SATEE_SDK_KEY` to a key for that host, and `SATEE_BASE_URL` to point at another one.

`src/flag-file.ts` holds the file handling a browser provider can share: it imports nothing from `node:`, and the caller
passes in the SHA-256 function. Its import of `@openfeature/flagd-core` still reaches a Node built-in: flagd-core's
CommonJS build requires `object-hash`, which requires `crypto`. A browser provider needs one of two ways out: a bundler
that picks `object-hash`'s browser build, or an evaluator other than flagd-core.

## Releasing

Pushing a tag `v<version>` on main, matching `package.json`, runs `.github/workflows/publish.yml`. One job reruns the
checks and packs the package without any npm credentials. A second job, in the `npm` environment, publishes that exact
tarball through npm trusted publishing, so no npm token is stored anywhere. The `npm` environment accepts only `v*` tags
and waits for a maintainer to approve the run. The npm trusted publisher entry names this repository, `publish.yml` and
the `npm` environment, so renaming any of them breaks publishing until the entry is updated.

```sh
npm version patch
git push origin main --follow-tags
```

## Versioning

The package follows [semver](https://semver.org). While it is at 0.x, the minor number is the breaking one: a minor
release (`0.x.0`) may break the API, and a patch release (`0.x.y`) never does. Pin it with a tilde range, such as
`~0.1.0`. On a 0.x version the caret range `npm install` writes, `^0.1.0`, also stops before the next minor, so the
default is safe too. Read the [changelog](CHANGELOG.md) before a minor upgrade.

## License

[MIT](LICENSE)
