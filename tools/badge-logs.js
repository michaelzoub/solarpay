import { createReadStream, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const port = process.env.BADGE_PORT || "/dev/cu.usbmodem1101";

if (!existsSync(port)) {
  console.error(`Badge serial device was not found: ${port}`);
  console.error("Connect and power on the badge, then check: ls /dev/cu.usbmodem*");
  process.exit(1);
}

try {
  execFileSync("stty", ["-f", port, "115200", "cs8", "-cstopb", "-parenb", "raw", "-echo"], { stdio: "ignore" });
} catch {
  console.error(`Could not configure ${port}.`);
  console.error("Disconnect the badge from Chrome's Sync/IDE/serial monitor, then retry.");
  console.error(`To find the current owner: lsof ${port}`);
  process.exit(1);
}

console.error(`Listening to ${port} at 115200 baud. Press Ctrl-C to stop.`);
const stream = createReadStream(port, { flags: "r", highWaterMark: 4096 });

stream.on("data", (chunk) => process.stdout.write(chunk));
stream.on("error", (error) => {
  console.error(`\nSerial read failed: ${error.message}`);
  console.error("Another program may own the port. Close Chrome's badge connection and retry.");
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  stream.destroy();
  process.stderr.write("\nBadge log monitor stopped.\n");
});
