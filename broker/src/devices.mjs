import { resolve } from "node:path";
import { DeviceStore } from "./server.mjs";

const dataFile = resolve(process.env.CMUX_BROKER_DATA_DIR ?? "./data", "devices.json");
const store = new DeviceStore(dataFile);
await store.load();

const args = process.argv.slice(2);
const relayFlag = args.indexOf("--relay");
let relayId;
if (relayFlag !== -1) {
  relayId = args[relayFlag + 1];
  if (!relayId || relayId.startsWith("--")) {
    console.error("--relay requires a relay id");
    process.exit(2);
  }
  args.splice(relayFlag, 2);
}
const [command, deviceId, ...extra] = args;
if (extra.length || (command === "list" && deviceId)) {
  console.error("usage: npm run devices -- <list|revoke DEVICE_ID> [--relay RELAY_ID]");
  process.exit(2);
}
switch (command) {
case "list":
  for (const device of store.allDevices(relayId)) {
    console.log([
      device.device_id,
      device.relay_id,
      device.device_name,
      device.registered_at,
    ].join("\t"));
  }
  break;
case "revoke":
  if (!deviceId) {
    console.error("usage: npm run devices -- revoke <device-id> [--relay RELAY_ID]");
    process.exitCode = 2;
    break;
  }
  if (await store.revoke(deviceId, relayId)) {
    console.log(`revoked ${deviceId}`);
  } else {
    console.error(`unknown device${relayId === undefined ? "" : " for selected relay"}: ${deviceId}`);
    process.exitCode = 1;
  }
  break;
default:
  console.error("usage: npm run devices -- <list|revoke DEVICE_ID> [--relay RELAY_ID]");
  process.exitCode = 2;
}
