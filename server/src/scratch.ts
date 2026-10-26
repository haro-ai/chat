import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

/**
 * Transient scratch lifecycle (ARCH §2.3 / §3):
 * snapshot → `<scratchRoot>/<conv>/<conv>.jsonl`; the conversation's pi child
 * runs with `--session-dir` inside that dir; everything is deleted on idle.
 * This is the ONLY place conversation bytes ever touch haro's disk.
 */
export class Scratch {
  constructor(
    private readonly config: Config,
    readonly conv: string,
  ) {}

  get dir(): string {
    return path.join(this.config.scratchRoot, this.conv);
  }

  get sessionPath(): string {
    return path.join(this.dir, `${this.conv}.jsonl`);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async writeSnapshot(lines: string[]): Promise<void> {
    await this.ensureDir();
    await writeFile(this.sessionPath, lines.join("\n") + "\n", "utf8");
  }

  async appendDelta(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    await appendFile(this.sessionPath, lines.join("\n") + "\n", "utf8");
  }

  /** Idle cleanup: nothing durable survives on haro. */
  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

export async function destroyScratchRoot(config: Config): Promise<void> {
  await rm(config.scratchRoot, { recursive: true, force: true });
}