import pino from "pino";

export function createLogger(name = "audio-outsourcing-tool") {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info"
  });
}
