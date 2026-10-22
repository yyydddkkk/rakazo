import { createServiceLogger } from "./env.js";
import { installLogger } from "./logger.js";
import type { Logger } from "./types.js";

export function createRootLogger(service: string, env: NodeJS.ProcessEnv = process.env): Logger {
  const logger = createServiceLogger({
    service,
    env,
  });
  installLogger(logger);
  return logger;
}
