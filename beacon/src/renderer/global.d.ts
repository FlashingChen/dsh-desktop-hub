import type { BeaconApi } from "../preload/preload";

declare global {
  interface Window {
    beacon: BeaconApi;
  }
}

export {};
