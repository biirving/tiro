/// <reference types="vite/client" />

import type { TiroBridge } from '@shared/types'

declare global {
  interface Window {
    tiro: TiroBridge
  }
}
