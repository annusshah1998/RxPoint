import { PRODUCT } from '@app/config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Boot } from './app/Boot';
import './styles.css';

document.title = PRODUCT.name;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
