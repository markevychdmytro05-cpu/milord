import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../core/model';

const api: DesktopApi = {
  testBehavior: input => ipcRenderer.invoke('test-behavior', input),
  stopBehaviorTest: profileId => ipcRenderer.invoke('stop-behavior-test', profileId),
  restoreCabinet: (input) => ipcRenderer.invoke('restore-cabinet', input),
  saveCabinet: (input) => ipcRenderer.invoke('save-cabinet', input),
  loadCabinetOrders: (input) => ipcRenderer.invoke('load-cabinet-orders', input),
  openCaptures: () => ipcRenderer.invoke('open-captures'),
  saveNbuAccount: (input) => ipcRenderer.invoke('save-nbu-account', input),
  clearNbuAccount: (profileId) => ipcRenderer.invoke('clear-nbu-account', profileId),
  loadCabinet: (profileId, sections, openProfile) => ipcRenderer.invoke('load-cabinet', { profileId, sections, openProfile }),
  loadCabinetOrder: (input) => ipcRenderer.invoke('load-cabinet-order', input),
  state: () => ipcRenderer.invoke('state'),
  saveSettings: (input) => ipcRenderer.invoke('save-settings', input),
  clearApiKey: () => ipcRenderer.invoke('clear-api-key'),
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  addTask: (input) => ipcRenderer.invoke('add-task', input),
  addTasks: (input) => ipcRenderer.invoke('add-tasks', input),
  cancelTask: (id) => ipcRenderer.invoke('cancel-task', id),
  updateTask: (input) => ipcRenderer.invoke('update-task', input),
  inspectProfile: (input) => ipcRenderer.invoke('inspect-profile', input),
};
contextBridge.exposeInMainWorld('desktop', api);
