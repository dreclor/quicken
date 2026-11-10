const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quickenDesktop', {
  showMain: target => ipcRenderer.send('quicken:main', target),
  onNavigate: listener => {
    const handle = (_event, target) => listener(target);
    ipcRenderer.on('quicken:navigate', handle);
    return () => ipcRenderer.removeListener('quicken:navigate', handle);
  },
  setChickenExpanded: expanded => ipcRenderer.send('quicken:expand-chicken', expanded),
  openAppleSettings: () => ipcRenderer.send('quicken:apple-settings'),
  startMeetingAudio: () => ipcRenderer.send('quicken:start-meeting-audio'),
  hideMeetingAudio: () => ipcRenderer.send('quicken:hide-meeting-audio'),
  showChicken: () => ipcRenderer.send('quicken:chicken'),
  closeChicken: () => ipcRenderer.send('quicken:hide-chicken'),
  getDetection: () => ipcRenderer.invoke('quicken:get-detection'),
  setDetection: enabled => ipcRenderer.send('quicken:set-detection', enabled),
  onDetection: listener => {
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('quicken:detection', handle);
    return () => ipcRenderer.removeListener('quicken:detection', handle);
  },
});
