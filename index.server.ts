import type { PluginServerContext } from "@getpaseo/plugin/server";
import { openSide } from "./server/side";
import { openSideRpc } from "./shared/side";

export default function contribute(server: PluginServerContext) {
  server.handle(openSideRpc, openSide);
  return () => {};
}
