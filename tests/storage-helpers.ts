import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const tempDir = () => mkdtemp(join(tmpdir(), "mosaic-store-"));
export const code = (r: any) => (r.ok ? "ok" : r.error.code);
