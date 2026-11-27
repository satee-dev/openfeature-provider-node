// docs:start
import { OpenFeature } from "@openfeature/server-sdk";
import { SateeProvider } from "@satee/openfeature-provider";

const sdkKey = process.env.SATEE_SDK_KEY;
await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey, baseUrl: process.env.SATEE_BASE_URL }));

const flags = OpenFeature.getClient();
const on = await flags.getBooleanValue("new-checkout", false);
// docs:end

console.log(`new-checkout: ${on}`);
setInterval(async () => {
  console.log(`new-checkout: ${await flags.getBooleanValue("new-checkout", false)}`);
}, 2000);
