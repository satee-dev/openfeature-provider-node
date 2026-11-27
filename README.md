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

| Option           | Default                          | Meaning                                                      |
| ---------------- | -------------------------------- | ------------------------------------------------------------ |
| `sdkKey`         | required                         | the key from the Setup page, with its `satee_sdk_` prefix    |
| `pollIntervalMs` | `5000`                           | time between polls; values below `1000` are raised to `1000` |
| `baseUrl`        | `https://flags.satee.dev`        | another host: a local server in tests, or the test host      |
| `logger`         | warnings and errors to `console` | an object with `debug`, `info`, `warn` and `error`           |

A missing key, or one without the `satee_sdk_` prefix or with nothing after it, throws from the constructor. That is
the only time the provider throws: a missing key is a deployment mistake, and it is best caught at start.

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
  default you passed, with `PROVIDER_NOT_READY`. Polling carries on at the normal interval.
- **No successful poll for 60 seconds** after flags were loaded: the provider emits `Stale` with "Could not refresh
  flags; serving the last good values", and keeps serving them.
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
characters, or just "key" for a very short one, and never include the key or the file URL.

[`examples/events.js`](examples/events.js) shows a handler for each of these events.

## Node support

Node 22.12 or later. The package is ESM only, and CommonJS can load it with `require()`.

## Reading the file directly

The provider reads one JSON file per key, in the [flagd](https://flagd.dev) flag format, without targeting rules. The
URL uses the key without its `satee_sdk_` prefix. To see what your app gets:

```sh
curl https://flags.satee.dev/YOUR_KEY_WITHOUT_PREFIX/flags.json
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
npm pack --dry-run
```

`npm run format` fixes formatting and safe lint findings in place. Node versions before 22.18 need
`NODE_OPTIONS=--experimental-strip-types` to run the tests, the examples and `check:live`.

`npm run check:live` reads a real file from the test host, `https://flags-test.satee.dev`, and checks that the
provider serves it. Set `SATEE_SDK_KEY` to a key for that host, and `SATEE_BASE_URL` to point at another one.

## License

[MIT](LICENSE)
