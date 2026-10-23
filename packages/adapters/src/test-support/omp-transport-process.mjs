import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "term-usage") {
  process.on("SIGTERM", () => {
    process.stdout.write(`${JSON.stringify({ type: "usage", input: 2, output: 3 })}\n`, () =>
      process.exit(0),
    );
  });
}
if (mode === "ignore-term" || mode === "descendant") process.on("SIGTERM", () => {});
if (mode === "leader-with-descendant") {
  const child = spawn(process.execPath, [process.argv[1], "descendant"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.pipe(process.stdout);
} else {
  process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid })}\n`);
}
if (mode === "eof") {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else {
  // Keep open even when stdin closes, to exercise bounded cleanup.
  process.stdin.resume();
  setInterval(() => {}, 1000);
}
