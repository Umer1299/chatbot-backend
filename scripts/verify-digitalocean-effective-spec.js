import fs from 'node:fs';
import { assertDigitalOceanEffectiveSpec } from './attest-digitalocean-source.js';

// Offline approval gate: pass a provider-exported effective spec file. This
// does not fetch, deploy, mutate or attest the provenance of that file.
const path = process.argv[2];
if (!path) throw new Error('Provide the path to the provider-exported effective app spec');
assertDigitalOceanEffectiveSpec(fs.readFileSync(path, 'utf8'), {
  approvedVpcId: process.env.STAGING_APPROVED_VPC_ID,
  approvedCommit: process.env.STAGING_APPROVED_COMMIT_SHA,
});
console.log('Effective DigitalOcean app spec matches approved private topology');
