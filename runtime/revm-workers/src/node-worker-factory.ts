import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RevmWorkerChannel, RevmWorkerFactory, RevmWorkerQualification } from "./lifecycle.ts";

export interface NodeRevmWorkerFactoryOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly qualification: RevmWorkerQualification;
}

/** Controller-side child-process adapter. Production bundle consumers receive
 * only an already-issued RevmWorkerFactory through the deployment port. */
export function createNodeRevmWorkerFactory(options: NodeRevmWorkerFactoryOptions): RevmWorkerFactory {
  return Object.freeze({
    async spawn(_epoch: string): Promise<RevmWorkerChannel> {
      const child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return createNodeRevmWorkerChannel(child);
    },
  });
}

export function createNodeRevmWorkerChannel(child: ChildProcessWithoutNullStreams): RevmWorkerChannel {
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let buffer = "";
  let exited = false;
  let exitCode: number | null = null;
  let resolveExit: ((code: number | null) => void) | null = null;
  child.stdout.setEncoding("utf8");
  child.stdout.pause();
  const drainLines = (): void => {
    for (;;) {
      if (lineListeners.size === 0) {
        child.stdout.pause();
        return;
      }
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      for (const listener of lineListeners) listener(line);
    }
  };
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    drainLines();
  });
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
    for (const listener of exitListeners) listener(code);
    resolveExit?.(code);
    resolveExit = null;
  });
  return Object.freeze({
    send(line: string): Promise<void> {
      if (exited || child.stdin.destroyed) return Promise.reject(new Error("REVM worker stdin is closed"));
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => error ? reject(error) : resolve());
      });
    },
    onLine(listener: (line: string) => void): () => void {
      lineListeners.add(listener);
      queueMicrotask(() => {
        drainLines();
        if (lineListeners.size > 0 && !exited) child.stdout.resume();
      });
      return () => {
        lineListeners.delete(listener);
        if (lineListeners.size === 0 && !exited) child.stdout.pause();
      };
    },
    onExit(listener: (code: number | null) => void): () => void {
      exitListeners.add(listener);
      if (exited) listener(exitCode);
      return () => exitListeners.delete(listener);
    },
    kill(signal = "SIGTERM"): void {
      if (!exited) child.kill(signal as NodeJS.Signals);
    },
    waitForExit(timeoutMs: number): Promise<boolean> {
      if (exited) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          if (resolveExit) resolveExit = null;
          resolve(false);
        }, timeoutMs);
        resolveExit = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(true);
        };
      });
    },
  });
}
