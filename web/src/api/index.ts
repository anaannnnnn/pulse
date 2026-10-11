import { httpApi, capabilities as httpCaps, type Api } from './client';
import { mockApi } from './mock';
import type { Capabilities } from './types';

const params = new URLSearchParams(location.search);
if (params.has('mock')) localStorage.setItem('pulse:mock', params.get('mock') === '0' ? '0' : '1');
/** Mock mode: in-memory data for UI work and design QA. Enable with ?mock=1 (disable with ?mock=0) or VITE_API_MOCK=1. */
export const isMock = import.meta.env.VITE_API_MOCK === '1' || localStorage.getItem('pulse:mock') === '1';

export const api: Api = isMock ? mockApi : httpApi;
export const caps: Capabilities = isMock ? { watchlist: true, studioFavorites: true, devices: true, pause: true, saveToPcloud: true, tokenFlow: true, clearServerData: true } : httpCaps;

export { ApiError, authEvents } from './client';
export type * from './types';
