import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const startMenubar = defineRpc({
  name: "menubar.start",
  input: z.object({}).strict(),
  output: z.object({ supported: z.boolean() }),
});
