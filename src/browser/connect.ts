import { chromium, type Browser, type BrowserContext, type Page } from 'patchright-core';

// Patchright never enables the Runtime domain and runs page.evaluate in an isolated world, so the site
// cannot see a debugger or our code. It does, however, emulate focus in every tab it attaches to, which
// makes all tabs report document.hasFocus() at once. Turning that off restores the browser's own focus.
async function naturalFocus(context: BrowserContext, page: Page): Promise<void> {
  try {
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await session.detach();
  } catch { /* The tab closed meanwhile. */ }
}

export async function connectProfile(endpoint: string, timeout: number): Promise<Browser> {
  const browser = await chromium.connectOverCDP(endpoint, { timeout, noDefaults: true });
  await Promise.all(browser.contexts().flatMap((context) => {
    context.on('page', (page) => { void naturalFocus(context, page); });
    return context.pages().map((page) => naturalFocus(context, page));
  }));
  return browser;
}
