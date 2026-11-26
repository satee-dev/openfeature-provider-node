# @satee/openfeature-provider

An [OpenFeature](https://openfeature.dev) provider for reading Satee feature flags in Node.

## Development

CI runs these commands in this order. Run them the same way before opening a pull request:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

`npm run format` fixes formatting and safe lint findings in place.

## License

[MIT](LICENSE)
