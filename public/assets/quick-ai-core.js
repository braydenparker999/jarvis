export const MODEL = 'openai/gpt-oss-120b';
export const STORAGE_KEY = 'jarvis.quick-ai.v1';
const SYSTEM = 'You are Quick AI, the on-demand assistant in Jarvis. Be helpful, direct, and honest. You have no browsing, tools, access to other Jarvis messages, or ability to perform actions. Never imply you checked live information or performed an action. Follow the language of the user. Today is ';

export function buildMessages(messages) {
  const turns = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push([{role: 'user', content: message.content.slice(0, 6000)}]);
    else if (message.role === 'assistant' && message.status === 'complete' && turns.length)
      turns.at(-1).push({role: 'assistant', content: message.content});
  }
  const selected = [];
  let size = 0;
  for (const turn of turns.reverse()) {
    const length = turn.reduce((n, m) => n + m.content.length, 0);
    if (size + length > 10000 && selected.length) break;
    selected.unshift(turn); size += length;
  }
  return [{role: 'system', content: SYSTEM + new Date().toISOString().slice(0, 10) + '.'}, ...selected.flat()];
}

export function parseHistory(raw) {
  if (!raw) return {version: 1, active: null, chats: []};
  const state = JSON.parse(raw);
  if (state.version !== 1 || !Array.isArray(state.chats) || state.chats.length > 50) throw new Error('Invalid saved chats');
  for (const chat of state.chats) {
    if (typeof chat.id !== 'string' || typeof chat.title !== 'string' || typeof chat.draft !== 'string' || !Array.isArray(chat.messages)) throw new Error('Invalid saved chat');
    for (const m of chat.messages) {
      if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new Error('Invalid saved message');
      if (m.role === 'assistant' && m.status !== 'complete') m.status = 'interrupted';
    }
  }
  return state;
}

export async function streamReply({key, messages, signal, onText, fetcher = fetch}) {
  if (!key) throw new Error('Quick AI has not been configured yet.');
  const response = await fetcher('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: {'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({model: MODEL, messages: buildMessages(messages), reasoning_effort: 'low', max_completion_tokens: 2048, stream: true}), signal
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error('The free usage limit was reached. Wait a little, then tap Retry.');
    if ([401, 403].includes(response.status)) throw new Error('Groq rejected the configured key. It needs to be updated once for the site.');
    throw new Error(`Groq is unavailable (${response.status}). Try again in a moment.`);
  }
  if (!response.body) throw new Error('Streaming is unavailable. Please retry.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', content = '', finish = null, done = false;
  const event = block => {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error('Groq interrupted the reply. Please retry.');
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === 'string') { content += choice.delta.content; onText(content); }
    if (choice?.finish_reason) finish = choice.finish_reason;
  };
  try {
    while (!done) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, {stream: !next.done});
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) { event(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      if (next.done) { if (buffer.trim()) event(buffer); break; }
    }
    if (!done || !finish) throw new Error('The connection ended before the reply finished. Tap Retry.');
    if (!content) throw new Error('No answer was returned. Tap Retry.');
    return {content, truncated: finish === 'length'};
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
