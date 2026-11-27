import { createServer } from "node:http";
import { OpenFeature } from "@openfeature/server-sdk";
import { SateeProvider } from "@satee/openfeature-provider";

const sdkKey = process.env.SATEE_SDK_KEY;
await OpenFeature.setProviderAndWait(new SateeProvider({ sdkKey, baseUrl: process.env.SATEE_BASE_URL }));
const flags = OpenFeature.getClient();

const server = createServer(async (_request, response) => {
  const on = await flags.getBooleanValue("new-checkout", false);
  response.end(on ? "new checkout\n" : "old checkout\n");
});
server.listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`listening on port ${server.address().port}`);
});

// docs:start
process.on("SIGTERM", async () => {
  await new Promise((resolve) => server.close(resolve));
  await OpenFeature.close();
  process.exit(0);
});
// docs:end
