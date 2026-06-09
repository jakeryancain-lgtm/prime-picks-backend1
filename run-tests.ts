import * as assert from 'assert';

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];
let currentSuite = '';

export function describe(suite: string, fn: () => void) {
  currentSuite = suite;
  fn();
}

export function it(name: string, fn: () => void | Promise<void>) {
  const fullName = `${currentSuite} > ${name}`;
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => results.push({ name: fullName, passed: true }))
        .catch((e: Error) => results.push({ name: fullName, passed: false, error: e.message }));
    } else {
      results.push({ name: fullName, passed: true });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name: fullName, passed: false, error: msg });
  }
}

export { assert };

export function printResults() {
  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`  ✓ ${r.name}`);
      passed++;
    } else {
      console.log(`  ✗ ${r.name}`);
      console.log(`    ${r.error}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
