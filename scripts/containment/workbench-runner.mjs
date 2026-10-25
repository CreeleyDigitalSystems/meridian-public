// Reviewed read-only runner. No evaluator, fixture suite, credentials or world state is mounted.
// Docker synthesizes HOME/HOSTNAME even for a scratch image; discard before importing resident bytes.
for(const key of Object.keys(process.env))if(key!=='PATH')delete process.env[key];
const chunks=[];let bytes=0;
for await(const c of process.stdin){bytes+=c.byteLength;if(bytes>8192)process.exit(65);chunks.push(c);}
const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const module=await import('/work/module.mjs');
if(typeof module.design!=='function')process.exit(66);
const value=await module.design(input);
const output=JSON.stringify(value);
if(typeof output!=='string'||Buffer.byteLength(output)>8192)process.exit(67);
process.stdout.write(output);
