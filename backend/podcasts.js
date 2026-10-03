// Podcast directory metadata and publisher RSS enclosures. No keys or new storage.
import {PRIMARY_SITE, FRONTEND_ORIGINS} from './origins.js';

export class PodcastError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
export function publicURL(value) {
  let u;
  try { u = new URL(value); } catch { throw new PodcastError('Enter a valid public RSS feed URL.', 400); }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || value.length > 2000 ||
      !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.includes('[') ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) ||
      /(?:^|\.)(?:nip\.io|sslip\.io|localtest\.me|lvh\.me)$/.test(host) || host === 'metadata.google.internal')
    throw new PodcastError('Only public podcast feed addresses are supported.', 400);
  u.hash = ''; return u.href;
}
const optionalURL = value => { try { return publicURL(value); } catch { return ''; } };
export const decodeXML = s => String(s || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code) => {
  if (code[0] !== '#') return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[code.toLowerCase()] || all;
  const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2),16) : Number(code.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
});
const text = (s, max = 3000) => decodeXML(decodeXML(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0,max);
const tag = (xml, name) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(xml)?.[1] || '';
const attr = (xml, name) => decodeXML(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(xml)?.[2] || '');
const image = xml => optionalURL(attr(/<itunes:image\b[^>]*>/i.exec(xml)?.[0] || '', 'href') || tag(tag(xml,'image'),'url'));
export function episodeID(s) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i),16777619); b = Math.imul(b,33) ^ s.charCodeAt(i); }
  return (a >>> 0).toString(16).padStart(8,'0') + (b >>> 0).toString(16).padStart(8,'0');
}
export function durationSeconds(value) {
  const parts = String(value).trim().split(':').map(Number);
  if (parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return 0;
  return Math.min(parts.reduce((n,v) => n * 60 + v,0),604800);
}
export function parseFeed(raw, feedUrl) {
  // Protect CDATA boundaries before matching RSS elements; never expand DTDs.
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new PodcastError('This feed uses unsupported XML declarations.');
  const xml = raw.replace(/<!--[\s\S]*?-->/g,'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,(_,s) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'));
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) throw new PodcastError('This address did not return a podcast RSS feed.',400);
  const header = xml.split(/<item\b/i,1)[0];
  const show = {id:episodeID(feedUrl), feedUrl, title:text(tag(header,'title'),300) || 'Podcast',
    author:text(tag(header,'itunes:author') || tag(header,'managingEditor'),200), description:text(tag(header,'description')),
    artwork:image(header), website:optionalURL(decodeXML(tag(header,'link')).trim()), language:text(tag(header,'language'),50)};
  const episodes = [], seen = new Set();
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const item = match[1], enclosure = /<enclosure\b[^>]*>/i.exec(item)?.[0] || '';
    const audioUrl = optionalURL(attr(enclosure,'url')), type = attr(enclosure,'type').toLowerCase();
    if (!audioUrl || (type && !type.startsWith('audio/') && !['application/octet-stream','application/ogg'].includes(type))) continue;
    const id = episodeID(decodeXML(tag(item,'guid')).trim() || audioUrl);
    if (seen.has(id)) continue; seen.add(id);
    const date = Date.parse(text(tag(item,'pubDate')));
    episodes.push({id, title:text(tag(item,'title'),500) || 'Untitled episode', description:text(tag(item,'content:encoded') || tag(item,'description'),7000),
      audioUrl, type:type || 'audio/mpeg', publishedAt:Number.isFinite(date) ? new Date(date).toISOString() : '',
      duration:durationSeconds(text(tag(item,'itunes:duration'))), bytes:Math.max(0,Number(attr(enclosure,'length')) || 0),
      artwork:image(item) || show.artwork, website:optionalURL(decodeXML(tag(item,'link')).trim())});
    if (episodes.length >= 200) break;
  }
  return {show, episodes};
}
async function boundedText(response, max = 4 * 1024 * 1024, feedPrefix = false) {
  if (!feedPrefix && Number(response.headers.get('Content-Length')) > max) { await response.body?.cancel(); throw new PodcastError('This feed is too large.',413); }
  const reader = response.body?.getReader(); if (!reader) return '';
  const decoder = new TextDecoder(), parts = []; let size = 0;
  for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length;
    if (size > max) {
      await reader.cancel();
      if (feedPrefix) {const prefix=parts.join('');const ends=[...prefix.matchAll(/<\/item\s*>/gi)];const last=ends.at(-1);if(last)return prefix.slice(0,last.index+last[0].length);}
      throw new PodcastError('This feed is too large.',413);
    } parts.push(decoder.decode(value,{stream:true})); }
  parts.push(decoder.decode()); return parts.join('');
}
export async function upstream(value, {fetcher = fetch, headers = {}, signal} = {}) {
  let url = publicURL(value);
  for (let i = 0; i <= 5; i++) {
    const response = await fetcher(url,{headers:{'User-Agent':'Jarvis-Podcasts/1.0',...headers},redirect:'manual',signal});
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('Location'); await response.body?.cancel();
      if (!location) throw new PodcastError('The podcast host returned an invalid redirect.');
      url = publicURL(new URL(location,url).href); continue;
    }
    return response;
  }
  throw new PodcastError('The podcast host redirected too many times.');
}
const memo = new Map();
async function cached(key, load, ttl = 600000) {
  const existing = memo.get(key); if (existing && existing.expires > Date.now()) return existing.value;
  const value = load(); memo.set(key,{value,expires:Date.now()+ttl});
  if (memo.size > 64) memo.delete(memo.keys().next().value);
  try { return await value; } catch (e) { memo.delete(key); throw e; }
}
export async function getFeed(feed, options = {}) {
  const url = publicURL(feed);
  const load = async () => {
    const r = await upstream(url,options);
    if (!r.ok) { await r.body?.cancel(); throw new PodcastError('This podcast feed is unavailable. Try again later.',r.status === 404 ? 404 : 502); }
    return parseFeed(await boundedText(r,4*1024*1024,true),url);
  };
  return options.fetcher ? load() : cached('feed:'+url,load);
}
const country = v => /^[a-z]{2}$/i.test(v || '') ? v.toLowerCase() : 'us';
export async function directory(q, region, options = {}) {
  const query = q.trim(); if (query.length < 2 || query.length > 120) throw new PodcastError('Enter at least two characters to search.',400);
  const load = async () => {
    const r = await upstream(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=podcast&entity=podcast&limit=36&country=${country(region)}`,options);
    if (!r.ok) { await r.body?.cancel(); throw new PodcastError('Podcast search is unavailable. Please try again.'); }
    const data = JSON.parse(await boundedText(r));
    return {shows:(data.results || []).filter(s => s.feedUrl && s.collectionName).map(s => ({id:String(s.collectionId),title:s.collectionName,author:s.artistName || '',
      feedUrl:optionalURL(s.feedUrl),artwork:optionalURL(s.artworkUrl600 || s.artworkUrl100),directoryUrl:optionalURL(s.collectionViewUrl),genres:s.genres || []})).filter(s => s.feedUrl)};
  };
  return options.fetcher ? load() : cached('search:'+country(region)+':'+query.toLowerCase(),load,1800000);
}
export const CATEGORIES = {popular:'podcast',history:'history',science:'science',technology:'technology',culture:'society culture',faith:'religion spirituality',music:'music',stories:'fiction storytelling'};
export async function podcasts(request, reply, options = {}) {
  const url = new URL(request.url); if (!url.pathname.startsWith('/podcasts/')) return null;
  if (!['GET','HEAD'].includes(request.method)) return reply({error:'Method not allowed'},405);
  const signal = AbortSignal.any([request.signal,AbortSignal.timeout(20000)]);
  const opts = {...options,signal};
  try {
    if (url.pathname === '/podcasts/health') return reply({ok:true,version:1});
    if (url.pathname === '/podcasts/search') return reply(await directory(url.searchParams.get('q') || '',url.searchParams.get('country'),opts));
    if (url.pathname === '/podcasts/browse') {
      const category = url.searchParams.get('category') || 'popular';
      if (!CATEGORIES[category]) return reply({error:'Unknown podcast category'},400);
      return reply(await directory(CATEGORIES[category],url.searchParams.get('country'),opts));
    }
    if (url.pathname === '/podcasts/feed') return reply(await getFeed(url.searchParams.get('url') || '',opts));
    if (url.pathname !== '/podcasts/audio') return reply({error:'Not found'},404);
    const {episodes} = await getFeed(url.searchParams.get('feed') || '',opts);
    const episode = episodes.find(e => e.id === url.searchParams.get('id'));
    if (!episode) return reply({error:'This episode is no longer in the feed. Use its original audio link.'},404);
    const range = request.headers.get('Range');
    if (range && !/^bytes=\d*-\d*$/.test(range)) return reply({error:'Invalid byte range'},416);
    // Stream enclosures only after resolving them from an actual podcast feed.
    // Bound connect time separately; podcast bodies can take longer to stream.
    const audioController = new AbortController();
    const connectTimer = setTimeout(() => audioController.abort(),20000);
    const abort = () => audioController.abort(); request.signal.addEventListener('abort',abort,{once:true});
    let r;
    try { r = await upstream(episode.audioUrl,{...options,headers:{Accept:'audio/*,application/octet-stream',...(range ? {Range:range} : {})},signal:audioController.signal}); }
    finally { clearTimeout(connectTimer); request.signal.removeEventListener('abort',abort); }
    if (![200,206,416].includes(r.status)) { await r.body?.cancel(); return reply({error:'The episode host could not serve this audio.'},502); }
    const type = (r.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
    if (r.status !== 416 && type && !type.startsWith('audio/') && !['application/octet-stream','application/ogg','video/mp4'].includes(type)) {
      await r.body?.cancel(); return reply({error:'The episode host returned an unsupported audio format.'},415);
    }
    const origin = request.headers.get('Origin');
    const h = new Headers({'Content-Type':type || episode.type,'Access-Control-Allow-Origin':FRONTEND_ORIGINS.has(origin) ? origin : PRIMARY_SITE,
      'Access-Control-Expose-Headers':'Content-Length, Content-Range, Accept-Ranges','Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    for (const name of ['Content-Length','Content-Range','Accept-Ranges']) if (r.headers.has(name)) h.set(name,r.headers.get(name));
    if (request.method === 'HEAD') { await r.body?.cancel(); return new Response(null,{status:r.status,headers:h}); }
    return new Response(r.body,{status:r.status,headers:h});
  } catch (e) { return reply({error:e instanceof PodcastError ? e.message : 'Could not reach the podcast service. Please try again.'},e.status || 502); }
}
