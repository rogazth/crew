import { expect, it } from "vitest";
import { client } from "./index";
import { transport } from "./transport";

it("hands the app the live daemon transport", () => {
  expect(client).toBe(transport);
});
