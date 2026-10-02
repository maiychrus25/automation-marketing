import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { useAppStore } from './store/appStore';

// Gán theme và thông tin cửa sổ trước lần render đầu để không chớp sai màu
// (CSP chặn script nội tuyến trong index.html nên làm ở đây).
const root = document.documentElement;
root.dataset.theme = useAppStore.getState().theme;

async function loadWindowAppearance(): Promise<void> {
  try {
    const info = await window.electronAPI?.window?.getAppearanceInfo?.();
    if (info) useAppStore.setState({ windowAppearance: info });
  } catch {
    // Không lấy được thì giữ giá trị mặc định trong appStore.
  }
  const { windowAppearance } = useAppStore.getState();
  root.dataset.material = windowAppearance.material;
  root.dataset.platform = windowAppearance.platform;
}

loadWindowAppearance().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
