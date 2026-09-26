const taskKey = (id) => `task:${id}`;

async function getTask(id) {
  const key = taskKey(id);
  return (await chrome.storage.local.get(key))[key];
}

async function patchTask(id, patch) {
  const task = await getTask(id);
  if (!task) return null;
  const next = { ...task, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [taskKey(id)]: next });
  return next;
}

async function allTasks() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith('task:'))
    .map(([, task]) => task);
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction: true,
  });
}

async function openProductTab(task) {
  const productUrl = new URL(task.url);
  const tabs = await chrome.tabs.query({ url: 'https://coins.bank.gov.ua/*' });
  const existing = tabs.find((tab) => tab.url && new URL(tab.url).pathname === productUrl.pathname);
  let tab;
  if (existing) {
    tab = await chrome.tabs.update(existing.id, { active: true });
    await chrome.tabs.reload(existing.id);
  } else {
    tab = await chrome.tabs.create({ url: task.url, active: true });
  }
  // A foreground tab is not timer-throttled, which keeps the countdown precise.
  await chrome.windows.update(tab.windowId, { focused: true });
  return tab;
}

async function arm(id) {
  const task = await getTask(id);
  if (!task || task.status !== 'scheduled') return;
  // Status must be saved before the tab loads so the content script picks the task up.
  await patchTask(id, { status: 'armed' });
  const tab = await openProductTab(task);
  await patchTask(id, { tabId: tab.id });
}

// Backup for the content-script countdown, e.g. when the laptop slept and page timers paused.
async function fireBackup(id) {
  const task = await getTask(id);
  if (!task || task.status !== 'armed') return;
  await patchTask(id, { status: 'firing' });
  const tab = await openProductTab(task);
  await patchTask(id, { tabId: tab.id });
}

async function schedule(task) {
  const armAt = task.saleAt - task.leadMin * 60_000;
  if (armAt <= Date.now() + 30_000) {
    await arm(task.id);
  } else {
    chrome.alarms.create(`arm:${task.id}`, { when: armAt });
  }
  if (task.saleAt > Date.now() + 30_000) {
    chrome.alarms.create(`fire:${task.id}`, { when: task.saleAt });
  }
}

async function removeTask(id) {
  await chrome.alarms.clear(`arm:${id}`);
  await chrome.alarms.clear(`fire:${id}`);
  await chrome.storage.local.remove(taskKey(id));
}

chrome.alarms.onAlarm.addListener(({ name }) => {
  const [kind, id] = name.split(':');
  if (kind === 'arm') arm(id);
  if (kind === 'fire') fireBackup(id);
});

// Alarms are not guaranteed to survive a browser restart.
chrome.runtime.onStartup.addListener(async () => {
  for (const task of await allTasks()) {
    if (task.status === 'scheduled') await schedule(task);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'add': {
        const task = {
          ...msg.task,
          id: crypto.randomUUID(),
          status: 'scheduled',
          clicks: 0,
          reloads: 0,
          createdAt: Date.now(),
        };
        await chrome.storage.local.set({ [taskKey(task.id)]: task });
        await schedule(task);
        return { ok: true };
      }
      case 'remove':
        await removeTask(msg.id);
        return { ok: true };
      case 'notify':
        notify(msg.title, msg.message);
        return { ok: true };
      default:
        return { ok: false };
    }
  })().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }));
  return true;
});
