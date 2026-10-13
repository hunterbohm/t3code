import { describe, expect, it } from "vite-plus/test";
import type { BrowserImportSource, EnvironmentId } from "@t3tools/contracts";

import {
  batchCookies,
  canCloseWizard,
  desktopPartitionEnvironmentIds,
  failedDestinationNames,
  syncDestinations,
  operableServerBrowserEnvironments,
  resolveMakeDefault,
  selectedDestinations,
  initialWizardStep,
  initialTargetSelection,
  isRetryableReason,
  formatSkippedDomains,
  fullDiskAccessRecheckStep,
  outcomeToStep,
  refreshedSourceProfileDirectory,
  refreshedSourceStep,
  resolveWizardTarget,
} from "./browserImportWizard.logic";

describe("wizard target selection", () => {
  it("treats an existing profile whose id is new as an existing target", () => {
    const profiles = [{ id: "new", name: "Existing new" }];
    const selection = initialTargetSelection(false, profiles);

    expect(selection).toEqual({ kind: "existing", profileId: "new" });
    expect(resolveWizardTarget(selection, "generated", profiles)).toEqual({
      kind: "existing",
      profileId: "new",
      name: "Existing new",
    });
  });

  it("rejects an existing target that is no longer listed", () => {
    expect(
      resolveWizardTarget({ kind: "existing", profileId: "removed" }, "generated", [
        { id: "default", name: "Default" },
      ]),
    ).toBeUndefined();
  });
});

const source = (over: Partial<BrowserImportSource> = {}): BrowserImportSource => ({
  id: "helium",
  name: "Helium",
  profiles: [{ directory: "Default", name: "You" }],
  ...over,
});

describe("initialWizardStep", () => {
  it("opens on the quit screen when the browser is running", () => {
    expect(initialWizardStep(source({ unavailable: "browserRunning" }))).toEqual({ step: "quit" });
  });

  it("opens on configure when the source is ready", () => {
    expect(initialWizardStep(source())).toEqual({ step: "configure" });
  });

  it("asks for Full Disk Access before choosing an import target", () => {
    expect(initialWizardStep(source({ profiles: [], unavailable: "needsFullDiskAccess" }))).toEqual(
      {
        step: "fullDiskAccess",
        resume: "configure",
      },
    );
  });

  it("blocks on a reason nothing local can fix", () => {
    expect(initialWizardStep(source({ unavailable: "unsupportedPlatform" }))).toEqual({
      step: "blocked",
      reason: "unsupportedPlatform",
    });
  });

  it("blocks a ready source that reports no importable profiles", () => {
    expect(initialWizardStep(source({ profiles: [] }))).toEqual({
      step: "blocked",
      reason: "unknownSourceProfile",
    });
  });

  it("handles source availability before checking its profiles", () => {
    expect(
      initialWizardStep(source({ profiles: [], unavailable: "needsKeychainApproval" })),
    ).toEqual({ step: "blocked", reason: "needsKeychainApproval" });
  });
});

describe("canCloseWizard", () => {
  it("keeps the wizard open while an import writes its target profile", () => {
    expect(canCloseWizard({ step: "importing" })).toBe(false);
    expect(canCloseWizard({ step: "configure" })).toBe(true);
    expect(canCloseWizard({ step: "blocked", reason: "readFailed" })).toBe(true);
  });
});

describe("outcomeToStep", () => {
  it("lands on done after a successful import", () => {
    expect(
      outcomeToStep({
        kind: "imported",
        imported: 12,
        skipped: 3,
        skippedDomains: ["example.com"],
        targetName: "Work",
        environments: [],
      }),
    ).toEqual({
      step: "done",
      imported: 12,
      skipped: 3,
      skippedDomains: ["example.com"],
      targetName: "Work",
      environments: [],
    });
  });

  it("routes a reopened browser back to the quit screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "browserRunning" })).toEqual({ step: "quit" });
  });

  it("routes a Full Disk Access refusal to its own screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "needsFullDiskAccess" })).toEqual({
      step: "fullDiskAccess",
      resume: "import",
      checked: true,
    });
  });

  it("surfaces every other failure on the blocked screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "readFailed" })).toEqual({
      step: "blocked",
      reason: "readFailed",
    });
  });
});

describe("refreshedSourceStep", () => {
  it("moves to configure once a quit browser frees its cookies", () => {
    expect(refreshedSourceStep(source())).toEqual({ step: "configure" });
  });

  it("stays on quit while the browser is still running", () => {
    expect(refreshedSourceStep(source({ unavailable: "browserRunning" }))).toEqual({
      step: "quit",
    });
  });

  it("blocks when the source vanished from the list", () => {
    expect(refreshedSourceStep(undefined)).toEqual({ step: "blocked", reason: "unknownSource" });
  });

  it("blocks when the refreshed source has no profiles", () => {
    expect(refreshedSourceStep(source({ profiles: [] }))).toEqual({
      step: "blocked",
      reason: "unknownSourceProfile",
    });
  });
});

describe("fullDiskAccessRecheckStep", () => {
  it("marks a still-denied access check for visible feedback", () => {
    expect(fullDiskAccessRecheckStep(source({ unavailable: "needsFullDiskAccess" }))).toEqual({
      step: "fullDiskAccess",
      resume: "configure",
      checked: true,
    });
  });

  it("moves on once access reveals the source profiles", () => {
    expect(fullDiskAccessRecheckStep(source())).toEqual({ step: "configure" });
  });
});

describe("refreshedSourceProfileDirectory", () => {
  const refreshed = source({
    profiles: [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 2", name: "Work" },
    ],
  });

  it("preserves a selected non-first profile after the browser quits", () => {
    expect(refreshedSourceProfileDirectory("Profile 2", refreshed)).toBe("Profile 2");
  });

  it("falls back only when the old profile vanished and clears an empty result", () => {
    expect(refreshedSourceProfileDirectory("Removed", refreshed)).toBe("Default");
    expect(refreshedSourceProfileDirectory("Removed", source({ profiles: [] }))).toBe("");
  });
});

describe("isRetryableReason", () => {
  it("offers a retry for failures a second attempt can clear", () => {
    expect(isRetryableReason("needsKeychainApproval")).toBe(true);
    expect(isRetryableReason("keychainUnavailable")).toBe(true);
    expect(isRetryableReason("readFailed")).toBe(true);
  });

  it("does not offer a retry for a permanent failure", () => {
    expect(isRetryableReason("unsupportedPlatform")).toBe(false);
    expect(isRetryableReason("unknownSourceProfile")).toBe(false);
    // Retrying the same new-profile import cannot lower the profile count.
    expect(isRetryableReason("profileLimitReached")).toBe(false);
  });

  it("offers a retry once the user has signed in to create the missing key", () => {
    // The blocked copy tells the user to sign in and retry, so the screen
    // has to offer the retry it asks for.
    expect(isRetryableReason("keychainItemMissing")).toBe(true);
  });

  it("offers a retry when the cookies landed but the new profile was not saved", () => {
    expect(isRetryableReason("profileNotSaved")).toBe(true);
  });
});

describe("formatSkippedDomains", () => {
  it("joins a short list naturally", () => {
    expect(formatSkippedDomains([])).toBe("");
    expect(formatSkippedDomains(["a.com"])).toBe("a.com");
    expect(formatSkippedDomains(["a.com", "b.com"])).toBe("a.com and b.com");
    expect(formatSkippedDomains(["a.com", "b.com", "c.com"])).toBe("a.com, b.com and c.com");
  });

  it("summarizes a long list", () => {
    expect(formatSkippedDomains(["a.com", "b.com", "c.com", "d.com", "e.com"])).toBe(
      "a.com, b.com, c.com and 2 more",
    );
  });
});

const env = (id: string) => id as EnvironmentId;
const destination = (id: string) => ({ environmentId: env(id), name: id });

describe("import destinations", () => {
  it("offers only environments with a server browser this client may operate", () => {
    const environments = ["local", "remote", "viewer-only", "no-browser"].map(destination);
    expect(
      operableServerBrowserEnvironments(
        environments,
        (id) => id !== "no-browser",
        new Set([env("local"), env("remote"), env("no-browser")]),
      ).map(({ environmentId }) => environmentId),
    ).toEqual(["local", "remote"]);
  });

  it("writes the primary partition however the destinations are chosen", () => {
    const destinations = ["primary", "remote"].map(destination);
    expect(desktopPartitionEnvironmentIds(env("primary"), [])).toEqual(["primary"]);
    expect(desktopPartitionEnvironmentIds(env("primary"), destinations)).toEqual([
      "primary",
      "remote",
    ]);
    expect(
      desktopPartitionEnvironmentIds(
        env("primary"),
        selectedDestinations(destinations, new Set([env("primary")])),
      ),
    ).toEqual(["primary", "remote"]);
  });

  it("starts with every destination on", () => {
    const destinations = ["a", "b"].map(destination);
    expect(selectedDestinations(destinations, new Set())).toEqual(destinations);
    expect(selectedDestinations(destinations, new Set([env("a")]))).toEqual([destination("b")]);
  });
});

describe("resolveMakeDefault", () => {
  it("defaults on for a new profile and off for an existing one", () => {
    expect(resolveMakeDefault(undefined, { kind: "new" })).toBe(true);
    expect(resolveMakeDefault(undefined, { kind: "existing", profileId: "work" })).toBe(false);
  });

  it("keeps the user's choice when the target changes", () => {
    expect(resolveMakeDefault(false, { kind: "new" })).toBe(false);
    expect(resolveMakeDefault(true, { kind: "existing", profileId: "work" })).toBe(true);
  });
});

describe("forwarding cookies to environments", () => {
  it("splits cookies into batches no larger than the limit", () => {
    expect(batchCookies([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batchCookies([], 2)).toEqual([]);
  });

  it("sums each environment's batches and fails only the one that rejects", async () => {
    const sent: Array<[string, number]> = [];
    const everyone = ["near", "far"].map(destination);
    const results = await syncDestinations({
      destinations: everyone,
      selected: new Set(everyone.map(({ environmentId }) => environmentId)),
      cookies: [1, 2, 3, 4, 5],
      batchSize: 2,
      send: async (environmentId, batch) => {
        sent.push([environmentId, batch.length]);
        if (environmentId === "far") throw new Error("unreachable");
        return { imported: batch.length - 1, skipped: 1 };
      },
      setDefault: undefined,
    });

    expect(results).toEqual([
      { ...destination("near"), cookies: { imported: 2, skipped: 3 }, defaultFailed: false },
      { ...destination("far"), cookies: "failed", defaultFailed: false },
    ]);
    expect(sent.filter(([id]) => id === "near")).toEqual([
      ["near", 2],
      ["near", 2],
      ["near", 1],
    ]);
    expect(sent.filter(([id]) => id === "far")).toEqual([["far", 2]]);
  });

  it("sets the default on every environment, after its cookies, and reports only the failures", async () => {
    const events: string[] = [];
    const everyone = ["on", "off", "down"].map(destination);
    const results = await syncDestinations({
      destinations: everyone,
      selected: new Set([env("on"), env("down")]),
      cookies: [1],
      batchSize: 2,
      send: async (environmentId) => {
        events.push(`cookies:${environmentId}`);
        return { imported: 1, skipped: 0 };
      },
      setDefault: async (environmentId) => {
        events.push(`default:${environmentId}`);
        if (environmentId === "down") throw new Error("unreachable");
      },
    });

    expect(results).toEqual([
      { ...destination("on"), cookies: { imported: 1, skipped: 0 }, defaultFailed: false },
      { ...destination("off"), cookies: "notSelected", defaultFailed: false },
      { ...destination("down"), cookies: { imported: 1, skipped: 0 }, defaultFailed: true },
    ]);
    expect(events.indexOf("cookies:on")).toBeLessThan(events.indexOf("default:on"));
    expect(events.indexOf("cookies:down")).toBeLessThan(events.indexOf("default:down"));
    expect(events).toContain("default:off");
  });

  it("does not finish until every environment has acknowledged its default", async () => {
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    let finished = false;
    const done = syncDestinations({
      destinations: [destination("slow")],
      selected: new Set([env("slow")]),
      cookies: [],
      batchSize: 2,
      send: async () => ({ imported: 0, skipped: 0 }),
      setDefault: () => acknowledged,
    }).then((results) => {
      finished = true;
      return results;
    });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    acknowledge();
    expect((await done)[0]?.defaultFailed).toBe(false);
    expect(finished).toBe(true);
  });
});

describe("failedDestinationNames", () => {
  it("awaits every environment and names the ones that rejected", async () => {
    const reached: string[] = [];
    const failed = await failedDestinationNames(
      ["a", "b", "c"].map(destination),
      async (environmentId) => {
        await Promise.resolve();
        reached.push(environmentId);
        if (environmentId !== "b") throw new Error("down");
      },
    );
    expect(failed).toEqual(["a", "c"]);
    expect(reached.toSorted()).toEqual(["a", "b", "c"]);
  });
});
