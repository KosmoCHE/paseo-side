import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const openSideRpc = defineRpc({
  name: "side.open",
  input: z.object({ agentId: z.string(), prompt: z.string() }),
  output: z.object({ agentId: z.string() }),
});
