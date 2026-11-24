import type { PluginServerContext } from "@getpaseo/plugin/server";
import { nameSideAfterFirstMessage, openSide } from "./server/side";
import { openSideRpc } from "./shared/side";

export default function contribute(server: PluginServerContext) {
  server.handle(openSideRpc, openSide);
  server.addHook("agent.turn.after", nameSideAfterFirstMessage);
  return () => {};
}
