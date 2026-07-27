/**
 * One-line condensation for the screens that have no footer. Kept out of the
 * component so it can be read on its own: it is a claim the console makes about
 * itself before anyone has signed in, and a claim is worth a test.
 * It says the
 * version and whether the encryption key is usable — process facts, which is
 * all this line can honestly carry: it renders before anything has queried the
 * database, so a word about postgres here would print the same whether the
 * database were up or down. The footer inside names it, after signing in, from
 * a reading that actually happened.
 */
export function consoleStatusLine({
  encryptionReady,
  version,
}: {
  encryptionReady: boolean;
  version: string;
}): string {
  return [
    `LLMIngress ${version}`,
    encryptionReady ? "encryption ok" : "encryption unavailable",
  ].join(" · ");
}
