import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../core/model';

const api: DesktopApi = {
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
