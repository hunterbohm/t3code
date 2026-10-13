import type { PreviewImportedCookie } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as Redacted from "effect/Redacted";
import type { BrowserContext } from "playwright-core";

const SAME_SITE = {
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
} as const;

/**
 * Playwright's `addCookies` derives a cookie's path from its url and rejects
 * both together, so a host-only cookie would lose its exact path. DevTools
 * takes url, domain, and path separately. A host-only cookie gets a url and no
 * domain: any domain marks it as a domain cookie and widens it to subdomains.
 */
const toCdpCookie = (cookie: PreviewImportedCookie) => ({
  name: cookie.name,
  value: Redacted.value(cookie.value),
  ...(cookie.domain === undefined ? { url: cookie.url } : { domain: cookie.domain }),
  path: cookie.path,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  ...(cookie.sameSite === "unspecified" ? {} : { sameSite: SAME_SITE[cookie.sameSite] }),
  ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
});

/**
 * Sets cookies one at a time, so a rejected cookie costs only itself. A
 * failure is counted, never reported with the cookie: its text can echo the
 * value.
 */
export const writeImportedCookies = async (
  context: BrowserContext,
  cookies: ReadonlyArray<PreviewImportedCookie>,
) => {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    let imported = 0;
    for (const cookie of cookies) {
      const { success } = await cdp
        .send("Network.setCookie", toCdpCookie(cookie))
        .catch(() => ({ success: false }));
      if (success) imported += 1;
    }
    return { imported, skipped: cookies.length - imported };
  } finally {
    await page.close().catch(constVoid);
  }
};
