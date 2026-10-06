// Display archive metadata without changing filenames or stored video records.
import {sortVideos} from './library.js';

export function knownCreators(library) {
  const names = new Set();
  for (const video of library?.videos || []) {
    if (typeof video.creator === 'string' && video.creator.trim()) names.add(video.creator.trim());
    if (video.folder && video.folder !== library.name) names.add(video.folder.split('/').at(-1));
  }
  return [...names].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function videoPresentation(video, creators = []) {
  const title = String(video.title || 'Untitled video');
  const explicit = typeof video.creator === 'string' ? video.creator.trim() : '';
  const prefix = (explicit ? [explicit] : creators).filter(Boolean).find(name => title.startsWith(name + ' - ') && title.length > name.length + 3);
  return {
    title: prefix ? title.slice(prefix.length + 3) : title,
    creator: explicit || prefix || '',
    collection: String(video.folder || '').split('/').at(-1) || ''
  };
}

export function sortDisplayedVideos(videos, mode, creators = []) {
  if (mode !== 'title') return sortVideos(videos, mode);
  const titles = new Map(videos.map(video => [video, videoPresentation(video, creators).title]));
  return [...videos].sort((a, b) => titles.get(a).localeCompare(titles.get(b), undefined, {numeric:true, sensitivity:'base'}));
}
