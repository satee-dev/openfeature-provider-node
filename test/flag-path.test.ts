import assert from "node:assert/strict";
import { it } from "node:test";
import { flagFilePath } from "../src/flag-path.ts";

it("derives the file path from the key as the published test vector says", () => {
  assert.equal(flagFilePath("7Rq2mXv9KpL4nTz8WbY3cHd6"), "/v1/b0c0c965477220edb232a9cabcfb54fc/flags.json");
});
