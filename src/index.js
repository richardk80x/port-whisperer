#!/usr/bin/env node

import {
  getListeningPorts,
  getPortDetails,
  findOrphanedProcesses,
  killProcess,
  watchPorts,
  isDevProcess,
  getAllProcesses,
} from "./scanner.js";
import {
  displayPortTable,
  displayPortDetail,
  displayCleanResults,
  displayWatchEvent,
  displayWatchHeader,
  displayProcessTable,
} from "./display.js";
import chalk from "chalk";
import { createInterface } from "readline";

const args = process.argv.slice(2);
const showAll = args.includes("--all") || args.includes("-a");

// NEW: support yes flag globally
const yesFlag = args.includes("--yes") || args.includes("-y");

const filteredArgs = args.filter(
  (a) => a !== "--all" && a !== "-a" && a !== "--yes" && a !== "-y",
);

const command = filteredArgs[0];

async function main() {
  // No args: show dev ports by default, --all for everything
  if (!command) {
    let ports = getListeningPorts();
    if (!showAll) {
      ports = ports.filter((p) => isDevProcess(p.processName, p.command));
    }
    displayPortTable(ports, !showAll);
    return;
  }

  // Specific port number
  const portNum = parseInt(command, 10);
  if (!isNaN(portNum)) {
    const info = getPortDetails(portNum);
    displayPortDetail(info);

    if (info) {
      // Skip prompt if --yes
      if (yesFlag) {
        const success = killProcess(info.pid);
        if (success) {
          console.log(chalk.green(`\n  ✓ Killed PID ${info.pid}\n`));
        } else {
          console.log(
            chalk.red(`\n  ✕ Failed. Try: sudo kill -9 ${info.pid}\n`),
          );
        }
        return;
      }

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question(
        chalk.yellow(`  Kill process on :${portNum}? [y/N] `),
        (answer) => {
          if (answer.toLowerCase() === "y") {
            const success = killProcess(info.pid);
            if (success) {
              console.log(chalk.green(`\n  ✓ Killed PID ${info.pid}\n`));
            } else {
              console.log(
                chalk.red(`\n  ✕ Failed. Try: sudo kill -9 ${info.pid}\n`),
              );
            }
          }
          rl.close();
        },
      );
    }
    return;
  }

  // Named commands
  switch (command) {
    case "ps": {
      let processes = getAllProcesses();
      if (!showAll) {
        processes = processes.filter((p) =>
          isDevProcess(p.processName, p.command),
        );
        const dockerProcs = processes.filter(
          (p) =>
            p.processName.startsWith("com.docke") ||
            p.processName.startsWith("Docker") ||
            p.processName === "docker" ||
            p.processName === "docker-sandbox",
        );
        const nonDocker = processes.filter(
          (p) =>
            !p.processName.startsWith("com.docke") &&
            !p.processName.startsWith("Docker") &&
            p.processName !== "docker" &&
            p.processName !== "docker-sandbox",
        );
        if (dockerProcs.length > 0) {
          const totalCpu = dockerProcs.reduce((s, p) => s + p.cpu, 0);
          const totalRssKB = dockerProcs.reduce((s, p) => {
            const m = (p.memory || "").match(/([\d.]+)\s*(GB|MB|KB)/);
            if (!m) return s;
            const val = parseFloat(m[1]);
            if (m[2] === "GB") return s + val * 1048576;
            if (m[2] === "MB") return s + val * 1024;
            return s + val;
          }, 0);
          const memStr =
            totalRssKB > 1048576
              ? `${(totalRssKB / 1048576).toFixed(1)} GB`
              : totalRssKB > 1024
                ? `${(totalRssKB / 1024).toFixed(1)} MB`
                : `${Math.round(totalRssKB)} KB`;
          nonDocker.push({
            pid: dockerProcs[0].pid,
            processName: "Docker",
            command: "",
            description: `${dockerProcs.length} processes`,
            cpu: totalCpu,
            memory: memStr,
            cwd: null,
            projectName: null,
            framework: "Docker",
            uptime: dockerProcs[0].uptime,
          });
        }
        processes = nonDocker;
      }
      processes.sort((a, b) => b.cpu - a.cpu);
      displayProcessTable(processes, !showAll);
      break;
    }

    case "clean": {
      // NEW: optional port argument
      const portArg = filteredArgs[1];
      const portNum = portArg ? parseInt(portArg, 10) : null;

      let orphaned = findOrphanedProcesses();

      // Filter by port if provided
      if (portNum && !isNaN(portNum)) {
        orphaned = orphaned.filter((p) => p.port === portNum);
      }

      const killed = [];
      const failed = [];

      if (orphaned.length === 0) {
        displayCleanResults(orphaned, killed, failed);
        return;
      }

      const runKill = () => {
        for (const p of orphaned) {
          if (killProcess(p.pid)) {
            killed.push(p.pid);
          } else {
            failed.push(p.pid);
          }
        }
        displayCleanResults(orphaned, killed, failed);
      };

      // Skip confirmation if --yes
      if (yesFlag) {
        runKill();
        return;
      }

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      console.log();
      console.log(
        chalk.yellow.bold(
          `  Found ${orphaned.length} orphaned/zombie process${orphaned.length === 1 ? "" : "es"}:`,
        ),
      );

      for (const p of orphaned) {
        console.log(
          `  ${chalk.gray("•")} :${chalk.white.bold(p.port)} — ${p.processName} ${chalk.gray(`(PID ${p.pid})`)}`,
        );
      }

      console.log();

      rl.question(chalk.yellow("  Kill all? [y/N] "), (answer) => {
        if (answer.toLowerCase() === "y") {
          runKill();
        } else {
          console.log(chalk.gray("\n  Aborted.\n"));
        }
        rl.close();
      });

      break;
    }

    case "watch": {
      displayWatchHeader();
      const interval = watchPorts((type, info) => {
        displayWatchEvent(type, info);
      }, 2000);

      process.on("SIGINT", () => {
        clearInterval(interval);
        console.log(chalk.gray("\n\n  Stopped watching.\n"));
        process.exit(0);
      });
      break;
    }

    case "help":
    case "--help":
    case "-h": {
      console.log();
      console.log(
        chalk.cyan.bold("  Port Whisperer") +
          chalk.gray(" — listen to your ports"),
      );
      console.log();
      console.log(chalk.white("  Usage:"));
      console.log(`    ${chalk.cyan("ports")}              Show dev server ports`);
      console.log(`    ${chalk.cyan("ports --all")}        Show all listening ports`);
      console.log(`    ${chalk.cyan("ports ps")}           Show all running dev processes`);
      console.log(`    ${chalk.cyan("ports <number>")}     Detailed info about a specific port`);
      console.log(`    ${chalk.cyan("ports clean")}        Kill orphaned/zombie dev servers`);
      console.log(`    ${chalk.cyan("ports clean <port>")} Kill orphaned process on a specific port`);
      console.log(`    ${chalk.cyan("ports clean --yes")}  Skip confirmation prompt`);
      console.log(`    ${chalk.cyan("ports watch")}        Monitor port changes in real-time`);
      console.log(`    ${chalk.cyan("whoisonport <num>")} Alias for ports <number>`);
      console.log();
      break;
    }

    default:
      console.log(chalk.red(`\n  Unknown command: ${command}`));
      console.log(
        chalk.gray(`  Run ${chalk.cyan("ports --help")} for usage.\n`),
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red(`\n  Error: ${err.message}\n`));
  process.exit(1);
});
