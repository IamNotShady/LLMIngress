export type WindowEntry = {
  resetsAt?: string;
  utilization: number;
  window: string;
};

export type BalanceEntry = {
  currency: string;
  granted?: string;
  toppedUp?: string;
  total: string;
};

export type QuotaEntry = BalanceEntry | WindowEntry;

export type ProviderQuotaErrorCode =
  | "not_supported"
  | "probe_failed"
  | "requires_separate_credential"
  | "unauthorized";

export function isWindowEntry(entry: QuotaEntry): entry is WindowEntry {
  return "window" in entry;
}

export function isBalanceEntry(entry: QuotaEntry): entry is BalanceEntry {
  return "currency" in entry;
}
