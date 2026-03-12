#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "./auth.js";

type CronAction = "install" | "remove";

interface CliOptions {
  action: CronAction;
  hour: number;
  minute: number;
}

interface ExecFileError extends Error {
  code?: number | string;
}

const CRON_MARKER = "linkedin-mcp-autopost";
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

function isValidTimePart(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function parseNumericFlag(flagValue: string | undefined, fallback: number): number {
  if (!flagValue) {
    return fallback;
  }
  const parsed = Number(flagValue);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const action: CronAction = argv.includes("--remove") ? "remove" : "install";

  const hourFlag = argv.find((item) => item.startsWith("--hour="));
  const minuteFlag = argv.find((item) => item.startsWith("--minute="));
  const hour = parseNumericFlag(hourFlag?.split("=")[1], DEFAULT_HOUR);
  const minute = parseNumericFlag(minuteFlag?.split("=")[1], DEFAULT_MINUTE);

  if (!isValidTimePart(hour, 23)) {
    throw new Error("Invalid --hour value. Use 0 to 23.");
  }

  if (!isValidTimePart(minute, 59)) {
    throw new Error("Invalid --minute value. Use 0 to 59.");
  }

  return {
    action,
    hour,
    minute,
  };
}

function escapeShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readCurrentCrontab(): Promise<string> {
  return new Promise((resolveValue, rejectValue) => {
    execFile("crontab", ["-l"], { encoding: "utf-8" }, (error, stdout) => {
      if (!error) {
        resolveValue(stdout);
        return;
      }

      const typedError = error as ExecFileError;
      if (typedError.code === 1) {
        resolveValue("");
        return;
      }

      rejectValue(error);
    });
  });
}

function writeCrontab(crontabContent: string): Promise<void> {
  return new Promise((resolveValue, rejectValue) => {
    const child = spawn("crontab", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      rejectValue(error);
    });

    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolveValue();
        return;
      }
      rejectValue(new Error(stderr || `Failed to write crontab (exit code ${exitCode ?? "unknown"}).`));
    });

    child.stdin.write(crontabContent);
    child.stdin.end();
  });
}

function removeManagedLine(currentCrontab: string): string[] {
  return currentCrontab
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.includes(CRON_MARKER));
}

function buildCronLine(hour: number, minute: number): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(currentFilePath), "..");
  const logPath = resolve(getConfigDir(), "autopost.log");

  const command = [
    `cd ${escapeShellValue(projectRoot)}`,
    "&&",
    "pnpm autopost",
    `>> ${escapeShellValue(logPath)} 2>&1`,
  ].join(" ");

  return `${minute} ${hour} */3 * * ${command} # ${CRON_MARKER}`;
}

async function installCron(hour: number, minute: number): Promise<void> {
  const currentCrontab = await readCurrentCrontab();
  const linesWithoutManagedEntry = removeManagedLine(currentCrontab);
  const cronLine = buildCronLine(hour, minute);
  const nextLines = [...linesWithoutManagedEntry, cronLine];
  const nextCrontab = `${nextLines.join("\n")}\n`;

  await writeCrontab(nextCrontab);

  console.log("Cron job installed successfully.");
  console.log(`Schedule: every 3 days at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  console.log(`Marker: ${CRON_MARKER}`);
}

async function removeCron(): Promise<void> {
  const currentCrontab = await readCurrentCrontab();
  const linesWithoutManagedEntry = removeManagedLine(currentCrontab);
  const nextCrontab =
    linesWithoutManagedEntry.length > 0 ? `${linesWithoutManagedEntry.join("\n")}\n` : "\n";

  await writeCrontab(nextCrontab);
  console.log("Managed auto-post cron job removed.");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.action === "remove") {
      await removeCron();
      return;
    }
    await installCron(options.hour, options.minute);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Cron configuration failed: ${message}`);
    process.exit(1);
  }
}

main();
