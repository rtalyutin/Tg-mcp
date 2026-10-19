// Public form metadata, shared by validation and the unavailable-state preview.
// This catalogue contains no owner records, provider credentials or sessions.
export const PHOTO_LIMITS = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxPixels: 64_000_000, size: 1024,
  formats: ['image/jpeg', 'image/png', 'image/webp'] });
export const PLAYER_FIELDS = Object.freeze([
  { id: 'nickname', type: 'string', scope: 'profile', required: true, maxLength: 64 },
  { id: 'name', type: 'string', scope: 'profile', required: false, maxLength: 200 },
  { id: 'city', type: 'string', scope: 'profile', required: false, maxLength: 120 },
]);
export const DEFAULT_PLAYER_DISCIPLINES = Object.freeze([{ code: 'cs', id: 'cs2', label: 'CS2', roles: [] }]);

export function unavailablePlayerContext(code) {
  const discipline = DEFAULT_PLAYER_DISCIPLINES.find((item) => item.code === code);
  return discipline ? { discipline, fields: PLAYER_FIELDS, photo: PHOTO_LIMITS,
    retryWindowMs: 86400_000, usagePermissions: [], available: false,
    providers: { telegram: false, vk: false } } : null;
}
