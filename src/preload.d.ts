import type { GisBridge } from './shared/ipc';

declare global {
  interface Window {
    gis: GisBridge;
  }
}

export {};
