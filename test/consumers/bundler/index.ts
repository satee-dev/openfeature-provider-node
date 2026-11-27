import { OpenFeature } from "@openfeature/server-sdk";
import { SateeProvider } from "@satee/openfeature-provider";

const sdkKey = process.env.SATEE_SDK_KEY;
await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey }));

const flags = OpenFeature.getClient();
const on: boolean = await flags.getBooleanValue("new-checkout", false);
console.log(on);
