import type { Locator, Page } from "@playwright/test";

// Helpers for the console's progressive-disclosure list pages: create forms,
// per-item rows, and heavy panels live inside native <details> that start
// collapsed, so tests open the relevant disclosure before interacting.
//
// These are idempotent "ensure open" helpers — clicking a <summary> toggles the
// <details>, so we only click when it is currently closed. That makes them safe
// to call even when a previous step already expanded the same row.

async function ensureOpen(summaryOrControl: Locator, details: Locator): Promise<void> {
  const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open).catch(() => false);
  if (!isOpen) {
    await summaryOrControl.click();
  }
}

/** Open a standalone disclosure (e.g. "New provider", "Add from template"). */
export async function openDisclosure(page: Page, label: string): Promise<void> {
  const summary = page.locator("summary.disclosure-summary", { hasText: label }).first();
  if ((await summary.count()) > 0) {
    await ensureOpen(summary, summary.locator("xpath=ancestor::details[1]"));
    return;
  }

  if (await page.getByRole("heading", { exact: true, name: label }).isVisible()) {
    return;
  }

  await page.getByRole("link", { exact: true, name: label }).click();
}

/** Open a collapsed list row by its title heading (e.g. a provider/agent name). */
export async function openRow(page: Page, name: string): Promise<void> {
  if (await page.getByRole("dialog", { exact: true, name: `Edit ${name}` }).isVisible()) {
    return;
  }

  const heading = page.locator("summary.row-summary").getByRole("heading", { name, exact: true });
  if ((await heading.count()) > 0) {
    await ensureOpen(heading, heading.locator("xpath=ancestor::details[1]"));
    return;
  }

  const agentRow = page.locator(".agent-management-row", {
    has: page.getByRole("heading", { exact: true, name }),
  });
  await agentRow.getByRole("link", { name: "Edit" }).click();
}
