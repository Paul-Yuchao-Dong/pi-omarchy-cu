import { execFile } from "node:child_process";
import type { ProcessInfo } from "../types.js";

/**
 * Default process listing used for AT-SPI blind-spot diagnostics.
 *
 * `args` (not just `comm`) is required: Chromium and Electron apps are only
 * recognisable as such from their command line.
 */
export function listProcessesWithPs(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "pid=,args="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const processes: ProcessInfo[] = [];
      for (const line of String(stdout).split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!match) continue;
        processes.push({ pid: Number(match[1]), command: match[2] });
      }
      resolve(processes);
    });
  });
}
