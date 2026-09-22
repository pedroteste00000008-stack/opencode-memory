export type LogLevel = "debug" | "info" | "warn" | "error"

const PREFIX = "[memory]"

export function log(level: LogLevel, ...args: unknown[]): void {
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "debug"
          ? console.debug
          : console.log
  fn(PREFIX, ...args)
}
