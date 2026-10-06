import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CustomerApp } from './CustomerApp';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CustomerApp />
  </StrictMode>,
);
