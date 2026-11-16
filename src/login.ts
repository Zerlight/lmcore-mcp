#!/usr/bin/env node
import { BASE_URL, SESSION_PATH } from "./config.js";
import { abortLoginSync, interactiveLogin } from "./session.js";

/**
 * Interactive login entrypoint.
 *
 * Launches a standalone Chrome window (without remote debugging) so the user can
 * authenticate through XJTLU SSO, then reopens the profile to capture and save
 * the session cookies.
 */
async function main(): Promise<void> {
  console.error(`Opening ${BASE_URL} for authentication...`);
  const session = await interactiveLogin({ log: (message) => console.error(message) });
  console.error(
    `Saved ${session.cookies.length} cookies to ${SESSION_PATH}.`,
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    abortLoginSync();
    console.error("Login cancelled.");
    process.exit(130);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
