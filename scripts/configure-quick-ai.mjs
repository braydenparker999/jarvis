import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// The owner approved a shared key in the deployed frontend. Keep it out of git
// and logs; GitHub Actions supplies it only when preparing a real deployment.
const key = process.env.GROQ_API_KEY?.trim();
if (!key) throw new Error('Set the GROQ_API_KEY Actions secret before deploying Quick AI.');
const directory = process.argv[2];
if (!['public', 'dist'].includes(directory)) throw new Error('Expected public or dist output directory.');
await writeFile(join(directory, 'assets/quick-ai-config.json'), JSON.stringify({apiKey: key}) + '\n');
console.log('Quick AI deployment configuration prepared.');
