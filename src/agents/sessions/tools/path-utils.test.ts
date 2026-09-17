import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveReadPath } from "./path-utils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function tempRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "read-boundary-")));
  roots.push(root);
  return root;
}
describe("read filename fallback boundary", () => {
  it.each([
    ["owner's", "owner’s"],
    ["owner\u00a0space", "owner space"],
  ])("does not redirect parent %s to %s", async (insideName, outsideName) => {
    const root = await tempRoot();
    const inside = path.join(root, insideName);
    const outside = path.join(root, outsideName);
    await fs.mkdir(inside);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    expect(resolveReadPath("secret.txt", inside)).toBe(path.join(inside, "secret.txt"));
  });
  it("retains filename normalization inside an unchanged parent", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "d’accord.txt"), "allowed");
    expect(resolveReadPath("d'accord.txt", root)).toBe(path.join(root, "d’accord.txt"));
    await fs.writeFile(path.join(root, "screen shot.txt"), "allowed");
    expect(resolveReadPath("screen\u00a0shot.txt", root)).toBe(path.join(root, "screen shot.txt"));
  });
});
