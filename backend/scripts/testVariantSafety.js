#!/usr/bin/env node

const assert = require("assert");
const overrides = require("../manualProductOverrides");
const { isExactRefMatch } = require("../matcher");

assert.strictEqual(isExactRefMatch("010-03198-01", "010-03198-01"), true);
assert.strictEqual(isExactRefMatch("010-03198-01", "010-03198-40"), false);
assert.strictEqual(isExactRefMatch("010-03198-40", "010-03198-01"), false);
assert.strictEqual(isExactRefMatch("010-03198-40", "010-03199-40"), false);
assert.strictEqual(isExactRefMatch("SSK059K1", "SSK059K1"), true);
assert.strictEqual(isExactRefMatch("SSK059K1", "SSK 059 K1"), true);
assert.strictEqual(isExactRefMatch("SSK059K1", "SSK-059-K1"), true);
assert.strictEqual(isExactRefMatch("SSK059K1", "SSK061K1"), false);

assert.strictEqual(
  overrides["wallaceallan.co.uk"]["010-03198-40"],
  "https://wallaceallan.co.uk/garmin-fenix-8-pro-47-mm-amoled-sapphire-carbon-grey-dlc-titanium-with-chestnut-leather-band-010-03198-40-watc-garm-fe8p-00009352.html"
);

console.log("Variant safety checks passed.");
