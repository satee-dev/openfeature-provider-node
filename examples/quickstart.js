// docs:start
import { OpenFeature } from "@openfeature/server-sdk";
import { SateeProvider } from "@satee/openfeature-provider";

const sdkKey = process.env.SATEE_SDK_KEY;
await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey }));

const flags = OpenFeature.getClient();
const print = async () => console.log(`new-checkout: ${await flags.getBooleanValue("new-checkout", false)}`);
await print();
setInterval(print, 2000);
// docs:end
