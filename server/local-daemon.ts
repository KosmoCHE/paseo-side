import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHostClient } from "@getpaseo/client/node";

export type LocalDaemon = ReturnType<typeof createHostClient>;

/**
 * Runs `work` on a connection of this plugin's own to the local daemon, for the calls the plugin
 * SDK does not offer: importing a provider session and setting an agent's model, mode and
 * thinking option. It signs in with the daemon home's local credential, as Paseo Desktop does.
 */
export async function withLocalDaemon<T>(work: (daemon: LocalDaemon) => Promise<T>): Promise<T> {
  const home = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
  const listen = config.daemon?.listen;
  if (typeof listen !== "string") throw new Error(`${home}/config.json 里没有 daemon.listen`);
  const daemon = createHostClient(listen, {
    clientId: "side-plugin-daemon",
    localCredential: async () => (await readFile(path.join(home, "local-credential"), "utf8")).trim(),
  });
  await daemon.connect();
  try {
    return await work(daemon);
  } finally {
    await daemon.close();
  }
}
