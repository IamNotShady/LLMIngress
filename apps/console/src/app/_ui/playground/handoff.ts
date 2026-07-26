/**
 * How the one-time screen hands its secret to the Playground.
 *
 * Not the query string: a URL is kept in history, offered back by the address
 * bar, and sent on as a referrer — and this is the one value the console cannot
 * show again if it leaks and has to be rotated. sessionStorage is same-origin
 * and dies with the tab, and the Playground removes the entry the moment it has
 * read it, so a later visit starts empty like any other.
 */
export const PLAYGROUND_KEY_HANDOFF = "llmingress-playground-key";
