import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { useAppStore } from './store/appStore';

// Gán theme trước lần render đầu để không chớp sai màu (CSP chặn script nội tuyến
// trong index.html nên làm ở đây).
document.documentElement.dataset.theme = useAppStore.getState().theme;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
