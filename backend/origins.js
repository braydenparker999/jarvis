// Keep the original frontend usable as a backup during the Storage migration.
export const PRIMARY_SITE = 'https://missionarytube.z13.web.core.windows.net';
export const FRONTEND_ORIGINS = new Set([
  PRIMARY_SITE,
  'https://gray-meadow-09216fd10.1.azurestaticapps.net'
]);
