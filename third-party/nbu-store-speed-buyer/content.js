(() => {
  const ACTIVE_STATUSES = ['armed', 'firing', 'clicked'];
  const SITE_CLICK_COOLDOWN_MS = 11_000; // the site ignores repeat clicks on a product within 10 s
  const MAX_CLICKS = 5;
  const FAST_RETRY_WINDOW_MS = 15_000;
  const WATCH_AFTER_CLICK_MS = 120_000;

  const taskKey = (id) => `task:${id}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { t } = I18n;
  const notify = (key, params) =>
    chrome.runtime
      .sendMessage({ type: 'notify', title: t(`notify.${key}.title`), message: t(`notify.${key}.message`, params) })
      .catch(() => {});

  let currentTaskId = null;
  // Pending timers are left to fire, so every reload goes through this guard.
  const reload = () => currentTaskId && location.reload();

  async function findTask() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith('task:'))
      .map(([, task]) => task)
      .filter((task) => ACTIVE_STATUSES.includes(task.status) && new URL(task.url).pathname === location.pathname)
      .sort((a, b) => a.saleAt - b.saleAt)[0];
  }

  async function patchTask(id, patch) {
    const key = taskKey(id);
    const task = (await chrome.storage.local.get(key))[key];
    if (!task) return null;
    const next = { ...task, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [key]: next });
    return next;
  }

  const isChallengePage = () =>
    !!document.querySelector('script[src*=".bunny-shield"]') || document.title.startsWith('Establishing a secure connection');

  // `cid_id` holds the customer id; the site itself redirects to login when it is empty.
  function loginState() {
    if (document.querySelector('#r_buy_intovar a.login')) return 'logged-out';
    const field = document.querySelector('[name="cid_id"]');
    if (!field) return 'unknown';
    return field.value ? 'logged-in' : 'logged-out';
  }

  function findBuyButton() {
    const form = document.querySelector('form[name="cart_quantity"]');
    if (!form || !form.querySelector('[name="products_id"]')) return null;
    const container = form.querySelector('#r_buy_intovar');
    if (!container || container.classList.contains('pointer_events_none')) return null;
    const button = container.querySelector('button[type="submit"].buy');
    if (!button || button.disabled || button.getClientRects().length === 0) return null;
    if (button.classList.contains('clicked') || button.classList.contains('limited')) return null;
    return button;
  }

  const isInCart = () => !!document.querySelector('#r_buy_intovar .added2cart, #r_buy_intovar a[href*="shopping_cart"]');
  const queuePosition = () => document.querySelector('#cart-queue-position')?.textContent.trim() || '';

  async function waitFor(fn, timeoutMs) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const value = fn();
      if (value || Date.now() >= until) return value;
      await sleep(100);
    }
  }

  // The HTTP Date header has 1 s resolution and is floored, so the estimate errs late, never early.
  async function measureServerOffset() {
    let best = null;
    for (let i = 0; i < 3; i++) {
      try {
        const sentAt = Date.now();
        const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store', credentials: 'include' });
        const receivedAt = Date.now();
        const serverDate = Date.parse(res.headers.get('date'));
        if (Number.isNaN(serverDate)) continue;
        const rtt = receivedAt - sentAt;
        const offset = serverDate - (sentAt + rtt / 2);
        if (!best || rtt < best.rtt) best = { rtt, offset };
      } catch {
        // Fall through to the next sample; with none, local time is used.
      }
    }
    return best ? Math.round(best.offset) : 0;
  }

  // Palette follows the Studio dark theme used by the popup; layout follows the shadcn Alert.
  const BANNER_CSS = `
    :host { all: initial; }
    .banner {
      --fg: oklch(0.965 0.004 160);
      --muted-fg: oklch(0.68 0.016 160);
      --tone: var(--fg);
      --tone-text: var(--muted-fg);
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: 420px; max-width: calc(100vw - 32px); box-sizing: border-box;
      padding: 10px 10px 14px 14px;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: var(--fg); background: oklch(0.2 0.009 160);
      border: 1px solid oklch(1 0 0 / 12%); border-radius: 12px;
      box-shadow: 0 10px 30px oklch(0 0 0 / 45%);
    }
    .banner[data-tone='ok'] { --tone: oklch(0.72 0.16 163); }
    .banner[data-tone='warn'] {
      --tone: oklch(0.79 0.15 75);
      --tone-text: color-mix(in oklch, var(--tone) 90%, transparent);
      border-color: color-mix(in oklch, var(--tone) 35%, transparent);
    }
    .banner[data-tone='error'] {
      --tone: oklch(0.704 0.191 22.216);
      --tone-text: color-mix(in oklch, var(--tone) 90%, transparent);
      border-color: color-mix(in oklch, var(--tone) 35%, transparent);
    }
    .head { display: flex; align-items: center; gap: 6px; min-height: 24px; }
    .head img { width: 14px; height: 14px; flex: none; }
    .brand {
      flex: 1; min-width: 0; font-size: 12px; font-weight: 500; color: var(--muted-fg);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .alert {
      display: grid; grid-template-columns: 16px 1fr; column-gap: 10px; row-gap: 2px;
      margin-top: 6px; padding-right: 4px;
    }
    .alert > svg { grid-row: span 2; margin-top: 2px; color: var(--tone); }
    .title { font-weight: 600; color: var(--tone); }
    .banner[data-tone='info'] .title { color: var(--fg); }
    .desc { color: var(--tone-text); white-space: pre-line; }
    .desc:empty { display: none; }
    button {
      display: inline-flex; align-items: center; justify-content: center; flex: none;
      width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
      color: var(--muted-fg); background: transparent; cursor: pointer;
    }
    button:hover { color: var(--fg); background: oklch(0.268 0.012 162); }
    button:focus-visible { outline: 2px solid oklch(0.72 0.16 163); outline-offset: 1px; }
    button[hidden] { display: none; }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .collapsed { width: auto; max-width: min(420px, calc(100vw - 32px)); padding: 6px 6px 6px 12px; }
    .collapsed .alert { display: none; }
    .collapsed .brand { font-size: 13px; font-weight: 600; color: var(--tone); }
    .collapsed[data-tone='info'] .brand { color: var(--fg); }
  `;
  // Lucide icons, the set shadcn uses.
  const ICONS = {
    minimize: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/></svg>',
    error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  };
  // sessionStorage is per tab and survives the automatic reloads.
  const COLLAPSED_KEY = 'nbu-speed-buyer:banner-collapsed';

  let bannerUi = null;

  function readCollapsed() {
    try {
      return sessionStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  function writeCollapsed(collapsed) {
    try {
      sessionStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // Collapsing still works for this page load.
    }
  }

  function createBanner() {
    const host = document.createElement('div');
    host.id = 'nbu-speed-buyer-banner';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${BANNER_CSS}</style>
      <div class="banner" role="region" aria-label="NBU Store Speed Buyer">
        <div class="head">
          <img alt="" src="${chrome.runtime.getURL('icons/logo-mark.svg')}">
          <span class="brand"></span>
          <button class="toggle" type="button"></button>
          <button class="close" type="button" hidden>${ICONS.close}</button>
        </div>
        <div class="alert">
          <span class="icon"></span>
          <div class="title"></div>
          <div class="desc"></div>
        </div>
      </div>`;
    const ui = {
      host,
      box: root.querySelector('.banner'),
      brand: root.querySelector('.brand'),
      icon: root.querySelector('.icon'),
      title: root.querySelector('.title'),
      desc: root.querySelector('.desc'),
      toggle: root.querySelector('.toggle'),
      close: root.querySelector('.close'),
      collapsed: readCollapsed(),
      final: false,
      tone: null,
      toggleState: null,
    };
    ui.toggle.addEventListener('click', () => {
      ui.collapsed = !ui.collapsed;
      writeCollapsed(ui.collapsed);
      renderBanner(ui);
    });
    ui.close.addEventListener('click', removeBanner);
    document.documentElement.appendChild(host);
    return ui;
  }

  function renderBanner(ui) {
    const collapsed = ui.collapsed && !ui.final;
    ui.box.classList.toggle('collapsed', collapsed);
    // Collapsed, the alert title stands in for the brand line.
    ui.brand.textContent = collapsed ? ui.title.textContent : 'NBU Store Speed Buyer';
    ui.toggle.hidden = ui.final;
    // The countdown re-renders every second; only swap the icon when the state changes.
    if (ui.toggleState !== collapsed) {
      ui.toggleState = collapsed;
      ui.toggle.innerHTML = collapsed ? ICONS.expand : ICONS.minimize;
    }
    const toggleLabel = t(collapsed ? 'banner.show' : 'banner.hide');
    ui.toggle.setAttribute('aria-label', toggleLabel);
    ui.toggle.title = toggleLabel;
    ui.close.setAttribute('aria-label', t('banner.close'));
    ui.close.title = t('banner.close');
    ui.close.hidden = !ui.final;
  }

  // The first line of `text` is the alert title, the rest its description.
  // `final` marks an end state: the banner expands and offers Close instead of Hide.
  function banner(text, tone = 'info', { final = false } = {}) {
    bannerUi ??= createBanner();
    const [title, ...rest] = text.split('\n');
    bannerUi.box.dataset.tone = tone;
    if (bannerUi.tone !== tone) {
      bannerUi.tone = tone;
      bannerUi.icon.outerHTML = ICONS[tone];
      bannerUi.icon = bannerUi.box.querySelector('.alert > svg');
    }
    bannerUi.title.textContent = title;
    bannerUi.desc.textContent = rest.join('\n');
    bannerUi.final = final;
    renderBanner(bannerUi);
  }

  function removeBanner() {
    bannerUi?.host.remove();
    bannerUi = null;
  }

  const formatCountdown = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  async function warnLoggedOut(task) {
    banner(t('banner.loggedOut'), 'error');
    if (!task.warnedLogin) {
      await patchTask(task.id, { warnedLogin: true });
      notify('loggedOut');
    }
  }

  async function waitForSale(task) {
    if (loginState() === 'logged-out') await warnLoggedOut(task);
    const offsetMs = await measureServerOffset();
    await patchTask(task.id, { offsetMs });
    const serverNow = () => Date.now() + offsetMs;

    const tick = () => {
      if (!currentTaskId || loginState() === 'logged-out') return;
      banner(t('banner.countdown', { countdown: formatCountdown(task.saleAt - serverNow()), offset: offsetMs }));
    };
    tick();
    setInterval(tick, 1000);

    setTimeout(async () => {
      const fresh = await patchTask(task.id, { status: 'firing' });
      if (fresh) reload();
    }, Math.max(0, task.saleAt - serverNow()));
  }

  async function attemptBuy(task) {
    const serverNow = Date.now() + (task.offsetMs || 0);
    if (serverNow < task.saleAt) {
      banner(t('banner.notStarted'));
      setTimeout(reload, task.saleAt - serverNow);
      return;
    }
    if (serverNow > task.saleAt + task.windowMin * 60_000) {
      await patchTask(task.id, { status: 'expired' });
      banner(t('banner.gaveUp'), 'error', { final: true });
      notify('gaveUp', { minutes: task.windowMin });
      return;
    }
    if (loginState() === 'logged-out') {
      await patchTask(task.id, { status: 'error', noteKey: 'note.notLoggedInAtSale' });
      banner(t('banner.loggedOutAtSale'), 'error', { final: true });
      notify('loggedOutAtSale');
      return;
    }

    const button = await waitFor(findBuyButton, 3000);
    if (button) {
      await clickBuy(task, button);
      return;
    }

    const reloads = (task.reloads || 0) + 1;
    await patchTask(task.id, { reloads });
    const baseMs = serverNow - task.saleAt < FAST_RETRY_WINDOW_MS ? Math.min(1000, task.retrySec * 1000) : task.retrySec * 1000;
    const delayMs = baseMs + Math.random() * 500;
    banner(t('banner.retrying', { reloads, seconds: (delayMs / 1000).toLocaleString(I18n.locale, { maximumFractionDigits: 1 }) }), 'warn');
    setTimeout(reload, delayMs);
  }

  async function clickBuy(task, button) {
    const updated = await patchTask(task.id, { status: 'clicked', clicks: (task.clicks || 0) + 1, clickedAt: Date.now() });
    if (!updated) return;
    button.click();
    banner(t('banner.clicked', { clicks: updated.clicks }), 'ok');
    if (updated.clicks === 1) notify('clicked');
    watchAfterClick(updated);
  }

  async function watchAfterClick(task) {
    const until = Date.now() + WATCH_AFTER_CLICK_MS;
    let lastClickAt = task.clickedAt || 0;
    let clicks = task.clicks || 0;
    let turnstileWarned = false;

    while (Date.now() < until) {
      await sleep(1000);
      if (currentTaskId !== task.id) return;

      if (isInCart()) {
        await patchTask(task.id, { status: 'done' });
        banner(t('banner.inCart'), 'ok', { final: true });
        notify('inCart');
        return;
      }

      const position = queuePosition();
      if (position) {
        banner(t('banner.inQueue', { position }), 'ok');
        continue;
      }

      const turnstile = document.querySelector('.cf-turnstile:not(.success)');
      if (turnstile && !turnstileWarned && Date.now() - lastClickAt > 6000) {
        turnstileWarned = true;
        banner(t('banner.turnstile'), 'warn');
        notify('turnstile');
      }

      // The site resets the button after a failed attempt (e.g. an overloaded server); click again.
      const button = findBuyButton();
      if (button && clicks < MAX_CLICKS && Date.now() - lastClickAt > SITE_CLICK_COOLDOWN_MS) {
        clicks += 1;
        lastClickAt = Date.now();
        await patchTask(task.id, { clicks, clickedAt: lastClickAt });
        button.click();
        banner(t('banner.reclicked', { clicks }), 'warn');
      }
    }
    banner(t('banner.stopped'), 'warn', { final: true });
  }

  async function main() {
    if (isChallengePage()) return; // the page reloads by itself once the CDN check passes
    await I18n.init();
    const task = await findTask();
    if (!task) return;
    currentTaskId = task.id;
    if (task.status === 'armed') return waitForSale(task);
    if (task.status === 'firing') return attemptBuy(task);
    if (task.status === 'clicked') return watchAfterClick(task);
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[I18n.LANG_KEY]) I18n.init(); // takes effect from the next banner update
    if (!currentTaskId) return;
    const change = changes[taskKey(currentTaskId)];
    if (change && !change.newValue) {
      currentTaskId = null;
      removeBanner();
    }
  });

  main();
})();
