#!/usr/bin/env node
import { BASE_URL, SESSION_PATH } from "./config.js";
import { interactiveLogin } from "./session.js";

/**
 * Interactive login entrypoint.
 *
 * Launches a standalone Chrome window so the user can authenticate through
 * XJTLU SSO, then writes the captured session cookies to disk.
 */
async function main(): Promise<void> {
  console.error(`Opening ${BASE_URL} for authentication...`);
  const session = await interactiveLogin({ log: (message) => console.error(message) });
  console.error(
    `Saved ${session.cookies.length} cookies to ${SESSION_PATH}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
