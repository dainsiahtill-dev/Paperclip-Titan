import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeUiBuildIdentity, verifyUiBuildIdentity } from './ui-build-identity.mjs';

test('compiled startup refuses changed source, changed assets and missing build identity', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-identity-'));
 try {
  for(const dir of ['ui/src','ui/public','ui/dist/assets','scripts']) fs.mkdirSync(path.join(root,dir),{recursive:true});
  for(const file of ['ui/src/main.tsx','ui/index.html','ui/vite.config.ts','ui/package.json','scripts/ui-build-identity.mjs']) fs.writeFileSync(path.join(root,file),'source');
  fs.writeFileSync(path.join(root,'ui/package.json'),'{"dependencies":{}}');
  fs.writeFileSync(path.join(root,'ui/dist/index.html'),'<script type="module" src="/assets/main.js"></script>');
  fs.writeFileSync(path.join(root,'ui/dist/assets/main.js'),'compiled');
  assert.throws(()=>verifyUiBuildIdentity(root),/build.*identity/i);
  writeUiBuildIdentity(root); assert.doesNotThrow(()=>verifyUiBuildIdentity(root));
  fs.writeFileSync(path.join(root,'ui/src/main.tsx'),'changed'); assert.throws(()=>verifyUiBuildIdentity(root),/source.*changed/i);
  fs.writeFileSync(path.join(root,'ui/src/main.tsx'),'source');
  fs.writeFileSync(path.join(root,'ui/dist/assets/main.js'),'broken'); assert.throws(()=>verifyUiBuildIdentity(root),/assets.*changed/i);
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
