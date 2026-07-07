// Electron の preload.js が提供する window.scheduleAPI を、
// ブラウザで直接開いた場合は localStorage ベースの実装で代替する。
// Electron 上ではすでに scheduleAPI が存在するため何もしない。
(function () {
  if (window.scheduleAPI) return;

  const STORAGE_KEY = 'schedule-data';

  window.scheduleAPI = {
    async loadData() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : { tasks: [], labels: [] };
      } catch {
        return { tasks: [], labels: [] };
      }
    },
    async saveData(data) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    },
  };
})();
