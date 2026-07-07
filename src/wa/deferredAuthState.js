import fs from "node:fs";
import path from "node:path";
import { BufferJSON, initAuthCreds, useMultiFileAuthState } from "@whiskeysockets/baileys";

const fixFileName = (file) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

export async function useDeferredMultiFileAuthState(folder) {
  const credsPath = path.join(folder, "creds.json");
  const alreadyLinked = await fs.promises
    .access(credsPath, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (alreadyLinked) return useMultiFileAuthState(folder);

  const creds = initAuthCreds();
  const memKeys = new Map(); // category -> Map(id -> value)
  const catMap = (category) => {
    let m = memKeys.get(category);
    if (!m) memKeys.set(category, (m = new Map()));
    return m;
  };

  let onDisk = false;

  const writeKeyFile = async (category, id, value) => {
    const filePath = path.join(folder, fixFileName(`${category}-${id}.json`));
    if (value === null || value === undefined) {
      await fs.promises.unlink(filePath).catch(() => {});
    } else {
      await fs.promises.writeFile(filePath, JSON.stringify(value, BufferJSON.replacer));
    }
  };

  const writeCredsFile = () => fs.promises.writeFile(credsPath, JSON.stringify(creds, BufferJSON.replacer));

  const flushToDisk = async () => {
    await fs.promises.mkdir(folder, { recursive: true });
    for (const [category, m] of memKeys) {
      for (const [id, value] of m) await writeKeyFile(category, id, value);
    }
    await writeCredsFile();
    onDisk = true;
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const m = catMap(type);
          const data = {};
          for (const id of ids) data[id] = m.get(id);
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            const m = catMap(category);
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) m.set(id, value);
              else m.delete(id);
              if (onDisk) await writeKeyFile(category, id, value ?? null);
            }
          }
        },
      },
    },
    saveCreds: async () => {
      if (!onDisk) {
        if (!creds.registered) return; // QR belum discan — jangan sentuh disk sama sekali.
        await flushToDisk();
        return;
      }
      await writeCredsFile();
    },
  };
}
