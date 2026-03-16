#!/usr/bin/env node

/**
 * LoL Challenge Exporter
 *
 * Connects to the running League of Legends client via its local API (LCU),
 * reads challenge completion data (which champions you've completed per challenge),
 * and exports it as a JSON file you can import into the web tracker.
 *
 * Usage:
 *   1. Open the League of Legends client
 *   2. Run: node export.mjs
 *   3. Upload the generated .json file on the web tracker
 */

import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LCUConnector = (await import('lcu-connector')).default;

function makeLCURequest(credentials, path) {
  const { address, port, username, password, protocol } = credentials;
  const url = `${protocol}://${address}:${port}${path}`;
  const auth = Buffer.from(`${username}:${password}`).toString('base64');

  return fetch(url, {
    headers: {
      accept: 'application/json',
      Authorization: `Basic ${auth}`,
    },
  }).then(res => {
    if (!res.ok) throw new Error(`LCU ${res.status}: ${path}`);
    return res.json();
  });
}

/**
 * Fetch champion numeric-ID-to-key mapping from Data Dragon.
 * Returns { "266": "Aatrox", "103": "Ahri", ... }
 */
async function getChampionIdMap() {
  const versions = await fetch('https://ddragon.leagueoflegends.com/api/versions.json').then(r => r.json());
  const version = versions[0];
  const data = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`).then(r => r.json());

  const map = {};
  for (const champ of Object.values(data.data)) {
    map[champ.key] = champ.id; // e.g. "266" -> "Aatrox"
  }
  return map;
}

console.log('Waiting for League of Legends client...');
console.log('(Make sure the client is open)\n');

const connector = new LCUConnector();

// Disable TLS verification for LCU's self-signed certificate
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

connector.on('connect', async (credentials) => {
  try {
    console.log('Connected to League client!');

    // Fetch champion ID mapping and LCU data in parallel
    const [champIdMap, summoner, challenges] = await Promise.all([
      getChampionIdMap(),
      makeLCURequest(credentials, '/lol-summoner/v1/current-summoner'),
      makeLCURequest(credentials, '/lol-challenges/v1/challenges/local-player'),
    ]);

    console.log(`Logged in as: ${summoner.displayName}`);

    // Build export: convert numeric champion IDs to riot_key strings
    const exportData = {};
    let totalChallenges = 0;
    let totalChampions = 0;
    let unmapped = 0;

    for (const [challengeId, challenge] of Object.entries(challenges)) {
      if (challenge.completedIds && challenge.completedIds.length > 0) {
        const champKeys = [];
        for (const numericId of challenge.completedIds) {
          const key = champIdMap[String(numericId)];
          if (key) {
            champKeys.push(key);
          } else {
            unmapped++;
          }
        }
        if (champKeys.length > 0) {
          exportData[challengeId] = {
            name: challenge.name || `Challenge ${challengeId}`,
            champions: champKeys,
          };
          totalChallenges++;
          totalChampions += champKeys.length;
        }
      }
    }

    const output = {
      version: 1,
      exportedAt: new Date().toISOString(),
      summoner: summoner.displayName,
      puuid: summoner.puuid,
      challenges: exportData,
    };

    const filename = `challenge-export-${summoner.displayName.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
    const outputPath = join(homedir(), 'Desktop', filename);

    writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log(`\nExported ${totalChallenges} challenges with ${totalChampions} champion completions`);
    if (unmapped > 0) {
      console.log(`(${unmapped} champion IDs could not be mapped — possibly new/unreleased champions)`);
    }
    console.log(`Saved to: ${outputPath}`);
    console.log('\nYou can now upload this file on the web tracker.');

    connector.stop();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    connector.stop();
    process.exit(1);
  }
});

connector.start();

// Timeout after 30 seconds
setTimeout(() => {
  console.error('\nTimed out waiting for League client. Is it running?');
  connector.stop();
  process.exit(1);
}, 30000);
