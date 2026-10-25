// Jest Setup File
// Configure test environment and global settings

import { config } from 'dotenv';

// Load environment variables from .env file if it exists
config();

// Set test timeout for longer-running API tests
jest.setTimeout(30000);

// Global test setup
beforeAll(() => {
  // Suppress console.log during tests unless explicitly testing logging
  if (process.env.NODE_ENV === 'test' && !process.env.VERBOSE_TESTS) {
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  }
});

// The Autotask read cache is module-level (per API user) — start every test
// cold so a response cached by one test can never be served to the next.
import { _resetHttpCache } from '../src/services/http-cache';
// Same for the auth-failure pause: a 401 in one test must not pause the next.
import { _resetAuthBlocks } from '../src/services/autotask-http';
beforeEach(() => {
  _resetHttpCache();
  _resetAuthBlocks();
});

// No network in tests: a unit test must never reach Autotask (or anything else) — with real credentials in the
// environment that would be a live call, and a failed login counts toward locking the shared API user. Calls to a
// fake host used to "pass" only because the DNS lookup failed fast (inside Docker it hangs until the timeout).
// Local servers the tests start themselves (127.0.0.1 / localhost) stay reachable; tests that need other answers
// mock fetch themselves.
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') return realFetch(input, init);
    throw new TypeError(`fetch failed: network access is disabled in tests (${url.host})`);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

// Global test cleanup
afterAll(() => {
  // Any cleanup operations
}); 