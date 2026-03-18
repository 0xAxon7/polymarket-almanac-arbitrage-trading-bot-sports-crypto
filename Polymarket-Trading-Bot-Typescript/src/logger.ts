import baseLog, { config as configure } from "@slackgram/logger";

function envLogLevel(): "debug" | "info" | "warn" | "error" | undefined {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return undefined;
}

const env = (process.env.NODE_ENV as "development" | "production" | "test" | undefined) ?? "development";

configure({
  env,
  minLevel: envLogLevel(),
  debug: process.env.LOG_DEBUG === "1" || process.env.LOG_DEBUG === "true",
  silent: process.env.LOG_SILENT === "1" || process.env.LOG_SILENT === "true",
  colors: true,
  file: process.env.LOG_FILE_PATH
    ? {
        enabled: true,
        filePath: process.env.LOG_FILE_PATH,
        prettyJson: env !== "production",
      }
    : false,
});

export const log = baseLog;

export function logLine(message: string, level: "debug" | "info" | "warn" | "error" = "info"): void {
  const cleaned = message.replace(/\n+$/, "");
  log[level](cleaned);
}

export async function flushLogs(): Promise<void> {
  await log.flush();
}

