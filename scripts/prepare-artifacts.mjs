import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

await mkdir(resolve("artifacts"), { recursive: true });
