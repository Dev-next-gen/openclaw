// Bounded binary subprocess capture for the file-transfer workers.
import { spawn } from "node:child_process";
import { killProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { consumeChildOutput } from "./child-output.js";

type Stream = "stdout" | "stderr";
type Result = {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  termination: "exit" | "timeout" | "output-limit" | "error";
  outputLimitStream?: Stream;
};

// July's process API decodes stdout to text. Retain binary tar output and
// fail on truncation, rather than adopting the newer process-runtime refactor.
export function runCommandBuffered(
  argv: string[],
  options: {
    timeoutMs: number;
    maxOutputBytes: number | Partial<Record<Stream, number>>;
    discardOutput?: Partial<Record<Stream, boolean>>;
    input?: Uint8Array;
    onOutputChunk?: (chunk: Buffer, stream: Stream) => boolean | void;
  },
): Promise<Result> {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(argv[0], argv.slice(1), {
      detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Record<Stream, Buffer[]> = { stdout: [], stderr: [] };
    const bytes: Record<Stream, number> = { stdout: 0, stderr: 0 };
    let settled = false;
    const finish = (
      termination: Result["termination"],
      code: number | null = null,
      outputLimitStream?: Stream,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (termination !== "exit" && child.pid) {
        // The archive worker spawns tar; terminate the whole owned tree so a
        // timeout or closed output pipe does not leave that descendant alive.
        killProcessTree(child.pid, { detached, force: true });
      }
      resolve({
        stdout: Buffer.concat(chunks.stdout),
        stderr: Buffer.concat(chunks.stderr),
        code,
        termination,
        ...(outputLimitStream ? { outputLimitStream } : {}),
      });
    };
    const timer = setTimeout(() => finish("timeout"), options.timeoutMs);
    for (const stream of ["stdout", "stderr"] as const) {
      consumeChildOutput(child[stream], {
        onData: (chunk) => {
          if (settled) return;
          if (options.onOutputChunk?.(chunk, stream) === false) {
            finish("output-limit", null, stream);
            return;
          }
          if (options.discardOutput?.[stream]) return;
          const limit =
            typeof options.maxOutputBytes === "number"
              ? options.maxOutputBytes
              : (options.maxOutputBytes[stream] ?? 64 * 1024);
          bytes[stream] += chunk.byteLength;
          if (bytes[stream] > limit) {
            finish("output-limit", null, stream);
            return;
          }
          chunks[stream].push(chunk);
        },
        onError: () => finish("error"),
      });
    }
    child.once("error", () => finish("error"));
    child.once("close", (code) => finish("exit", code));
    child.stdin.once("error", () => finish("error"));
    child.stdin.end(options.input);
  });
}
