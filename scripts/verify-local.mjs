// Real official-app smoke test; never uses the user's Codex profile or chats.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverCodex, launchCodex, verifyEndpoint } from '../src/platform.mjs';
import { CodexConnection } from '../src/cdp.mjs';
import { DEFAULTS } from '../src/settings.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-open-sea-verify-'));
const installation=await discoverCodex();
const port=19371;
const launched=await launchCodex({installation,port,profileDir:path.join(root,'profile'),codexHome:path.join(root,'home')});
await fs.writeFile(path.join(root,'run.json'),JSON.stringify({root,port,pid:launched.pid,version:installation.version}));
console.log(JSON.stringify({root,port,pid:launched.pid,version:installation.version}));
const verify=()=>verifyEndpoint({installation,port,process:launched,timeoutMs:10000});
const identity=await verify();
console.log('Verified loopback endpoint: '+identity.browserId);
const connection=new CodexConnection({identity,verify});
const payload=await fs.readFile(new URL('../dist/skin.js',import.meta.url),'utf8');
for(const target of await connection.targets()){
  const session=await connection.attach(target);
  console.log(JSON.stringify({target:target.id,installation:await session.install(payload,DEFAULTS)}));
  console.log(JSON.stringify({status:await session.evaluate('window.__codexOpenSea?.status() ?? null')}));
}
console.log('Isolated app remains open for visual verification; close only its window when done.');
// Leave the owned process observable; no broad kill or access to live user data.
launched.process.on('exit',()=>{connection.close();console.log('Isolated app exited.');});
