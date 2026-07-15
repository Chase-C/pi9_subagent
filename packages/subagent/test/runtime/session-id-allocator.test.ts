import { test } from "vitest";
import assert from "node:assert/strict";

import { SessionIdAllocator } from "../../src/runtime/session-id-allocator.js";

test("allocates lowercase adjective-noun session IDs", () => {
  const id = new SessionIdAllocator(() => 0).allocate();
  if (id === undefined) throw new Error("expected an allocated session ID");

  assert.match(id, /^[a-z]+-[a-z]+$/);
  assert.equal(id, id.toLowerCase());
});

test("retries collisions and falls back deterministically", () => {
  let randomCalls = 0;
  const allocator = new SessionIdAllocator(() => {
    randomCalls += 1;
    return 0;
  });

  const first = allocator.allocate();
  const second = allocator.allocate();

  assert.equal(first, "amber-acorn");
  assert.equal(second, "amber-antelope");
  assert.equal(randomCalls, 2 + 32 * 2);
});

test("keeps repeated allocations unique with a deterministic collision-heavy source", () => {
  const allocator = new SessionIdAllocator(() => 0);
  const ids = Array.from({ length: 100 }, () => allocator.allocate());

  assert.equal(new Set(ids).size, ids.length);
});

test("returns undefined after exhausting the adjective-noun namespace", () => {
  const allocator = new SessionIdAllocator(() => 0);
  const ids = Array.from({ length: 100 * 100 }, () => allocator.allocate());

  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => typeof id === "string" && /^[a-z]+-[a-z]+$/.test(id)));
  assert.equal(allocator.allocate(), undefined);
});
