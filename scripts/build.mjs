import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('../dist/', import.meta.url), {recursive:true});
await build({entryPoints:['runtime/skin.js','runtime/preview.js'],outdir:'dist',bundle:true,format:'iife',target:'chrome140',minify:true,legalComments:'eof',loader:{'.jpg':'dataurl','.svg':'dataurl'}});
console.log('Built local, self-contained Codex skin and ocean preview.');
