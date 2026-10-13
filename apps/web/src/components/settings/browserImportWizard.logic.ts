import type {
  BrowserImportFailureReason,
  BrowserImportSource,
  EnvironmentId,
} from "@t3tools/contracts";

export interface WizardTargetProfile {
  readonly id: string;
  readonly name: string;
}

/** An environment whose own browser can take imported sign-ins. */
export interface ImportDestination {
  readonly environmentId: EnvironmentId;
  readonly name: string;
}

/**
 * How one environment's browser fared. Only its own row fails when it cannot
 * be reached, and the default can fail while the cookies arrive.
 */
export interface EnvironmentImportResult extends ImportDestination {
  readonly cookies:
    | { readonly imported: number; readonly skipped: number }
    | "failed"
    | "notSelected";
  readonly defaultFailed: boolean;
}

export type WizardTarget =
  | { readonly kind: "new"; readonly profileId: string }
  | { readonly kind: "existing"; readonly profileId: string; readonly name: string };

export type WizardTargetSelection =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly profileId: string };

export function initialTargetSelection(
  canCreateProfile: boolean,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTargetSelection {
  if (canCreateProfile) return { kind: "new" };
  const first = targetProfiles[0];
  return first ? { kind: "existing", profileId: first.id } : { kind: "new" };
}

export function resolveWizardTarget(
  selection: WizardTargetSelection,
  newProfileId: string,
  targetProfiles: ReadonlyArray<WizardTargetProfile>,
): WizardTarget | undefined {
  if (selection.kind === "new") return { kind: "new", profileId: newProfileId };
  const profile = targetProfiles.find((candidate) => candidate.id === selection.profileId);
  if (profile === undefined) return undefined;
  return {
    kind: "existing",
    profileId: selection.profileId,
    name: profile.name,
  };
}

/**
 * What the import wizard produces once it has actually tried to import. The
 * parent runs the import and classifies the result; the wizard only reacts to
 * it, which keeps the step transitions pure and testable.
 */
export type ImportOutcome =
  | {
      readonly kind: "imported";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
      readonly environments: ReadonlyArray<EnvironmentImportResult>;
    }
  | { readonly kind: "blocked"; readonly reason: BrowserImportFailureReason };

/**
 * The wizard's screens. Every one is a place the user can act from — there are
 * no dead ends. `blocked` covers the reasons no local step recovers.
 */
export type WizardStep =
  | { readonly step: "quit" }
  | {
      readonly step: "fullDiskAccess";
      readonly resume: "configure" | "import";
      readonly checked?: boolean;
    }
  | { readonly step: "configure" }
  | { readonly step: "checking"; readonly check: "browser" | "fullDiskAccess" }
  | { readonly step: "importing" }
  | {
      readonly step: "done";
      readonly imported: number;
      readonly skipped: number;
      readonly skippedDomains: ReadonlyArray<string>;
      readonly targetName: string;
      readonly environments: ReadonlyArray<EnvironmentImportResult>;
    }
  | { readonly step: "blocked"; readonly reason: BrowserImportFailureReason };

/** The import owns its target partition until the write finishes. */
export function canCloseWizard(step: WizardStep): boolean {
  return step.step !== "importing";
}

/**
 * Where the wizard opens for a source. A running browser is the one thing we
 * know up front, from the source listing; everything else is discovered by
 * trying, so the wizard starts by letting the user choose what to import.
 */
export function initialWizardStep(source: BrowserImportSource): WizardStep {
  if (source.unavailable === "browserRunning") return { step: "quit" };
  if (source.unavailable === "needsFullDiskAccess") {
    return { step: "fullDiskAccess", resume: "configure" };
  }
  if (source.unavailable !== undefined) return { step: "blocked", reason: source.unavailable };
  if (source.profiles.length === 0) return { step: "blocked", reason: "unknownSourceProfile" };
  return { step: "configure" };
}

/** Where an attempted import lands the wizard, by how it turned out. */
export function outcomeToStep(outcome: ImportOutcome): WizardStep {
  if (outcome.kind === "imported") {
    return {
      step: "done",
      imported: outcome.imported,
      skipped: outcome.skipped,
      skippedDomains: outcome.skippedDomains,
      targetName: outcome.targetName,
      environments: outcome.environments,
    };
  }
  // A browser that reopened mid-import routes back to the quit screen; every
  // other failure surfaces on the blocked screen, which offers a retry when
  // one could help.
  if (outcome.reason === "browserRunning") return { step: "quit" };
  if (outcome.reason === "needsFullDiskAccess") {
    // The failed import already checked access, so explain that it is still
    // denied instead of returning to an indistinguishable permission screen.
    return { step: "fullDiskAccess", resume: "import", checked: true };
  }
  return { step: "blocked", reason: outcome.reason };
}

/** Where a fresh availability check lands the wizard after the user quits. */
export function refreshedSourceStep(source: BrowserImportSource | undefined): WizardStep {
  if (source === undefined) return { step: "blocked", reason: "unknownSource" };
  return initialWizardStep(source);
}

/** A denied FDA recheck returns to the permission step with visible feedback. */
export function fullDiskAccessRecheckStep(source: BrowserImportSource | undefined): WizardStep {
  const next = refreshedSourceStep(source);
  return next.step === "fullDiskAccess" ? { ...next, checked: true } : next;
}

/** Preserve the chosen source profile when a post-quit refresh still lists it. */
export function refreshedSourceProfileDirectory(
  currentDirectory: string,
  source: BrowserImportSource,
): string {
  if (source.profiles.some((profile) => profile.directory === currentDirectory)) {
    return currentDirectory;
  }
  return source.profiles[0]?.directory ?? "";
}

/**
 * Whether retrying could clear a failure. The keychain prompt can be approved
 * on a second try, a missing key appears once the user signs in to the
 * browser (which is what its copy asks for), and a read or session error may
 * be transient; an unsupported browser will not change, so it gets no retry
 * button.
 */
export function isRetryableReason(reason: BrowserImportFailureReason): boolean {
  switch (reason) {
    case "needsKeychainApproval":
    case "keychainItemMissing":
    case "keychainUnavailable":
    case "readFailed":
    case "sessionUnavailable":
    case "profileNotSaved":
      return true;
    default:
      return false;
  }
}

/**
 * Names the sites whose cookies were skipped: "example.com and google.com",
 * or "a, b, c and 4 more" past a few, so the line stays short.
 */
export function formatSkippedDomains(domains: ReadonlyArray<string>): string {
  if (domains.length === 0) return "";
  if (domains.length === 1) return domains[0]!;
  if (domains.length <= 3) return `${domains.slice(0, -1).join(", ")} and ${domains.at(-1)}`;
  return `${domains.slice(0, 3).join(", ")} and ${domains.length - 3} more`;
}

/** Environments an import can reach: their browser runs on the server and this client may operate it. */
export function operableServerBrowserEnvironments<
  T extends { readonly environmentId: EnvironmentId },
>(
  environments: ReadonlyArray<T>,
  hasServerBrowser: (environmentId: EnvironmentId) => boolean,
  operable: ReadonlySet<EnvironmentId>,
): ReadonlyArray<T> {
  return environments.filter(
    ({ environmentId }) => hasServerBrowser(environmentId) && operable.has(environmentId),
  );
}

/** Every destination is on until the user turns it off. */
export function selectedDestinations(
  destinations: ReadonlyArray<ImportDestination>,
  excluded: ReadonlySet<EnvironmentId>,
): ReadonlyArray<ImportDestination> {
  return destinations.filter(({ environmentId }) => !excluded.has(environmentId));
}

/**
 * The environments whose desktop partitions receive the cookies. The primary
 * is always written, because its tabs are the ones this window renders; a
 * remote destination's partition lets the desktop's own tabs for it sign in too.
 */
export function desktopPartitionEnvironmentIds(
  primary: EnvironmentId,
  selected: ReadonlyArray<ImportDestination>,
): readonly [EnvironmentId, ...ReadonlyArray<EnvironmentId>] {
  return [
    primary,
    ...selected.map(({ environmentId }) => environmentId).filter((id) => id !== primary),
  ];
}

/** A new profile becomes the default unless the user said otherwise. */
export function resolveMakeDefault(
  choice: boolean | undefined,
  selection: WizardTargetSelection,
): boolean {
  return choice ?? selection.kind === "new";
}

export function batchCookies<T>(
  cookies: ReadonlyArray<T>,
  size: number,
): ReadonlyArray<ReadonlyArray<T>> {
  const batches: Array<ReadonlyArray<T>> = [];
  for (let start = 0; start < cookies.length; start += size) {
    batches.push(cookies.slice(start, start + size));
  }
  return batches;
}

/**
 * Runs `action` on each destination and returns the names of those where it
 * rejected. Every destination is awaited.
 */
export async function failedDestinationNames(
  destinations: ReadonlyArray<ImportDestination>,
  action: (environmentId: EnvironmentId) => Promise<void>,
): Promise<ReadonlyArray<string>> {
  const outcomes = await Promise.all(
    destinations.map(({ environmentId, name }) =>
      action(environmentId).then(
        () => undefined,
        () => name,
      ),
    ),
  );
  return outcomes.filter((name) => name !== undefined);
}

/**
 * Brings each destination up to date: the selected ones get the cookies in
 * batches, and with `makeDefault` every one gets the agent default, after its
 * cookies. Resolves only once every environment has acknowledged or failed.
 * Destinations run side by side; one that rejects fails its own row.
 */
export function syncDestinations<C>(input: {
  /** Every environment that can take an agent default. */
  readonly destinations: ReadonlyArray<ImportDestination>;
  readonly selected: ReadonlySet<EnvironmentId>;
  readonly cookies: ReadonlyArray<C>;
  readonly batchSize: number;
  readonly send: (
    environmentId: EnvironmentId,
    batch: ReadonlyArray<C>,
  ) => Promise<{ readonly imported: number; readonly skipped: number }>;
  readonly setDefault: ((environmentId: EnvironmentId) => Promise<void>) | undefined;
}): Promise<ReadonlyArray<EnvironmentImportResult>> {
  const batches = batchCookies(input.cookies, input.batchSize);
  return Promise.all(
    input.destinations.map(async (destination): Promise<EnvironmentImportResult> => {
      let cookies: EnvironmentImportResult["cookies"] = "notSelected";
      if (input.selected.has(destination.environmentId)) {
        let imported = 0;
        let skipped = 0;
        try {
          for (const batch of batches) {
            const result = await input.send(destination.environmentId, batch);
            imported += result.imported;
            skipped += result.skipped;
          }
          cookies = { imported, skipped };
        } catch {
          cookies = "failed";
        }
      }
      const defaultFailed =
        input.setDefault !== undefined &&
        (await input.setDefault(destination.environmentId).then(
          () => false,
          () => true,
        ));
      return { ...destination, cookies, defaultFailed };
    }),
  );
}
