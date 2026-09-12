import * as assert from "node:assert/strict";
import { test } from "node:test";
import { environmentSupport } from "../src/environment";

test("desktop local is supported, remote and browser environments have explicit reasons", () => {
  assert.deepEqual(environmentSupport(undefined, false), { supported: true, reason: null });
  for (const remote of ["ssh-remote", "wsl", "dev-container"])
    assert.deepEqual(environmentSupport(remote, false), { supported: false, reason: "remote" });
  assert.deepEqual(environmentSupport(undefined, true), { supported: false, reason: "web" });
});
