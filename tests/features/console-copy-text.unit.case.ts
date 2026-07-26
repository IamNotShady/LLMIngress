import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../../apps/console/src/app/_ui/copy-text.ts";

type FakeArea = { remove: () => void; select: () => void; setAttribute: () => void } & {
  style: Record<string, string>;
  value: string;
};

/** A document whose execCommand copies whatever the textarea was given. */
function fakeDocument(execCommand: (command: string) => boolean) {
  const areas: FakeArea[] = [];
  return {
    areas,
    document: {
      body: { append: () => {} },
      createElement: () => {
        const area = {
          remove: () => {},
          select: () => {},
          setAttribute: () => {},
          style: {} as Record<string, string>,
          value: "",
        };
        areas.push(area);
        return area;
      },
      execCommand,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copying a value the operator would otherwise retype", () => {
  it("uses the clipboard when the page is allowed one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", fakeDocument(() => false).document);

    await expect(copyText("llmi_secret")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("llmi_secret");
  });

  it("still copies where there is no clipboard api at all", async () => {
    // Plain http on a self-hosted host: navigator.clipboard is undefined, and
    // the optional call that used to stand here did nothing and said "copied".
    const { areas, document } = fakeDocument(() => true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", document);

    await expect(copyText("llmi_secret")).resolves.toBe(true);
    expect(areas[0]?.value).toBe("llmi_secret");
  });

  it("falls back when the clipboard rejects the write", async () => {
    const { areas, document } = fakeDocument(() => true);
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("not focused")) },
    });
    vi.stubGlobal("document", document);

    await expect(copyText("llmi_secret")).resolves.toBe(true);
    expect(areas[0]?.value).toBe("llmi_secret");
  });

  it("says it did not copy rather than saying nothing", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", fakeDocument(() => false).document);
    await expect(copyText("llmi_secret")).resolves.toBe(false);

    // No document either — an environment that cannot copy is not a copy.
    vi.stubGlobal("document", undefined);
    await expect(copyText("llmi_secret")).resolves.toBe(false);
  });
});
