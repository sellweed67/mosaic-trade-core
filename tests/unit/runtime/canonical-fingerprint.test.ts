import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalize, computeFingerprint, fingerprintPreimage } from "../../../core/runtime/canonical-fingerprint.ts";

const dest = { id: "data", kind: "module" } as const;
const fp = (payload: unknown, major = 1) => ({ contract_version: { major, minor: 0 }, destination: dest, message_type: "COMMAND" as const, payload });
const VECTORS: [string, unknown, number, string, number][] = [
  ["key ordering", { b: 1, a: 2 }, 1, "353ebaf5d74f6530df6bcb66b397b0eb3508170b24832ac5b499ce878dca92b4", 135],
  ["negative zero", { count: -0 }, 1, "3cc3e0afcdfba4a99399cf67abae3a538682ed2926cf9ac3993c24bcbe9a1251", 133],
  ["escaping & controls", { text: "Line 1\nLine 2\t\"quoted\"\u0000\u001F" }, 1, "f9f1671438556c0142f405ff2cfd86e601aa2f945c39fc61cbd0774f0988b470", 171],
  ["unicode order & surrogate pair", { "😀": "emoji", "é": "accent", e: "plain" }, 1, "2d571f713fe505424eb9dfaafe9ee35664ccc29a72db0c74a3775474ea4f5550", 164],
  ["contract version 1.0", { a: 1 }, 1, "0f39376888027a31d9019df2f16ea95764cbe1f38903edfed7e9d8b972e195e8", 129],
  ["contract version 2.0", { a: 1 }, 2, "af2ae21604338001f42bf2e9195b586676e393a57888cf363e6f6010822fc9cb", 129],
];
for (const [name, payload, major, hash, bytes] of VECTORS) {
  test(`golden vector: ${name}`, () => {
    const pre = fingerprintPreimage(fp(payload, major));
    assert.equal(Buffer.byteLength(pre, "utf8"), bytes);
    assert.equal(createHash("sha256").update(pre, "utf8").digest("hex"), hash);
    assert.equal(computeFingerprint(fp(payload, major)), hash);
  });
}
test("exact preimage text for vectors 1 and 3", () => {
  assert.equal(fingerprintPreimage(fp({ b: 1, a: 2 })), '{"contract_version":{"major":1,"minor":0},"destination":{"id":"data","kind":"module"},"message_type":"COMMAND","payload":{"a":2,"b":1}}');
  assert.equal(canonicalize("\u0000\u001F\b\f\r"), '"\\u0000\\u001F\\b\\f\\r"');
});

const bad = (v: unknown, rule: string) => assert.throws(() => canonicalize(v), (e: any) => e.code === "contract.invalid_payload" && e.details.rule === rule && e.is_retryable === false);
test("rejects unsupported values deterministically", () => {
  bad({ a: 1n }, "unsupported_bigint");
  bad({ a: () => 1 }, "unsupported_function");
  bad({ a: Symbol("x") }, "unsupported_symbol");
  bad({ a: undefined }, "unsupported_undefined");
  bad([1, , 3], "sparse_array");
  bad(new Array(2), "sparse_array");
  const c: any = { x: 1 }; c.self = c; bad(c, "circular_reference");
  bad(Object.defineProperty({}, "g", { get: () => 1, enumerable: true }), "accessor_property");
  bad({ s: "\uD800" }, "lone_surrogate");
  bad({ s: "a\uDC00b" }, "lone_surrogate");
  bad({ n: 2 ** 53 }, "unsafe_integer");
  bad({ n: -(2 ** 53) }, "unsafe_integer");
  bad({ n: NaN }, "non_finite_number");
  bad({ n: Infinity }, "non_finite_number");
  bad({ n: -Infinity }, "non_finite_number");
  for (const inst of [new Date(0), new Map(), new Set(), /x/, Promise.resolve(), new (class A {})()]) bad({ v: inst }, "class_instance");
  bad({ [Symbol("k")]: 1 }, "symbol_key");
});
test("repeated references that are not cycles are allowed", () => {
  const shared = { z: 1 };
  assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"z":1},"b":{"z":1}}');
});
test("normalization: -0, safe integers, fractions (JCS), null-prototype objects", () => {
  assert.equal(canonicalize([-0, 0, 9007199254740991, -9007199254740991, 1.5, 1e-7, 1.2e21 / 1e10]), "[0,0,9007199254740991,-9007199254740991,1.5,1e-7,120000000000]");
  assert.equal(canonicalize(0.1 + 0.2), "0.30000000000000004");
  assert.equal(canonicalize(Object.assign(Object.create(null), { b: 1, a: [true, null] })), '{"a":[true,null],"b":1}');
  assert.equal(computeFingerprint(fp({ count: -0 })), computeFingerprint(fp({ count: 0 })));
});
