import { OpenFeature } from "@openfeature/server-sdk";
import { SateeProvider } from "@satee/openfeature-provider";

async function main() {
  const provider = new SateeProvider({
    sdkKey: "satee_server_7Rq2mXv9KpL4nTz8WbY3cHd6",
    baseUrl: "http://127.0.0.1:9",
  });
  OpenFeature.setProvider(provider);
  const on: boolean = await OpenFeature.getClient().getBooleanValue("new-checkout", false);
  await OpenFeature.close();
  console.log(`${provider.metadata.name} loaded from CommonJS, new-checkout: ${on}`);
}

void main();
