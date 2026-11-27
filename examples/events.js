import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import { SateeProvider } from "@satee/openfeature-provider";

// docs:start
OpenFeature.addHandler(ProviderEvents.Ready, () => {
  console.log("Satee provider is ready");
});
OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, (details) => {
  console.log(`Satee flags changed: ${(details?.flagsChanged ?? []).join(", ")}`);
});
OpenFeature.addHandler(ProviderEvents.Stale, (details) => {
  console.warn(`Satee flags may be out of date: ${details?.message}`);
});
OpenFeature.addHandler(ProviderEvents.Error, (details) => {
  console.error(`Satee flags are unavailable: ${details?.message}`);
});
// docs:end

const sdkKey = process.env.SATEE_SDK_KEY;
await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey, baseUrl: process.env.SATEE_BASE_URL }));

// Polling does not hold the process open, so keep it running to watch for changes until stopped.
setInterval(() => {}, 60_000);
