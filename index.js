// Dependencies: npm install node-fetch axios p-limit lru-cache dotenv discord-webhook-node
import 'dotenv/config';
import fetch from 'node-fetch';
import axios from 'axios';
import fs from 'fs';
import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';
import { Webhook, MessageBuilder } from 'discord-webhook-node';

// CONFIGS
const MORALIS_KEYS = JSON.parse(process.env.MORALIS_KEYS);
const MID_TIER_WEBHOOK = process.env.MID_TIER_WEBHOOK;
const HIGH_TIER_WEBHOOK = process.env.HIGH_TIER_WEBHOOK;

const MID_TIER_WEBHOOK_CLIENT = new Webhook(MID_TIER_WEBHOOK);
const HIGH_TIER_WEBHOOK_CLIENT = new Webhook(HIGH_TIER_WEBHOOK);

const hoursPerBlock = 6;
const keysPerDay = MORALIS_KEYS.slice();
const dailyKeyOrder = shuffleArray(keysPerDay);
const startOfDay = new Date().setHours(0, 0, 0, 0);

function getCurrentMoralisKey() {
  const now = Date.now();
  const hoursSinceMidnight = Math.floor((now - startOfDay) / 3600000);
  const index = Math.floor(hoursSinceMidnight / hoursPerBlock) % dailyKeyOrder.length;
  return dailyKeyOrder[index];
}

function shuffleArray(arr) {
  return arr
    .map((val) => ({ val, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ val }) => val);
}

const LOG_FILE = 'tokens.log';
const trackedTokens = new LRUCache({ max: 2000, ttl: 1000 * 60 * 180 }); // track 3 hours
const limit = pLimit(5);
let pollInterval = 30000;

function log(message) {
  const logMsg = `[${new Date().toISOString()}] ${message}`;
  console.log(logMsg);
  fs.appendFileSync(LOG_FILE, logMsg + '\n');
}

async function fetchNewMoralisTokens() {
  try {
    const res = await fetch(
      'https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new?limit=100',
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-API-Key': getCurrentMoralisKey(),
        },
      }
    );
    const data = await res.json();
    return data?.result || [];
  } catch (err) {
    log(`❌ Moralis Fetch Error: ${err.message}`);
    return [];
  }
}

async function fetchDexscreenerDetails(tokenAddress, retries = 2) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`);
    return data?.[0] || null;
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return fetchDexscreenerDetails(tokenAddress, retries - 1);
    }
    log(`❌ Dexscreener Error for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

async function sendToDiscord(token, webhookClient, tier) {
  const {
    baseToken, marketCap, priceUsd, volume, txns, priceChange, url, pairAddress
  } = token;

  const embed = new MessageBuilder()
    .setTitle(`🚀 ${baseToken.name} ($${baseToken.symbol}) — ${tier} Tier`)
    .setURL(url)
    .setThumbnail('')
    .addField('💰 Market Cap', `$${(marketCap ?? 0).toLocaleString()}`, true)
    .addField('💸 Price', `$${priceUsd}`, true)
    .addField('📊 Volume (1h)', `${volume?.h1 ?? 0} SOL`, true)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys ?? 0}`, true)
    .addField('📈 Change (5m)', `${priceChange?.m5 ?? 0}%`, true)
    .addField('🔗 Photon', `[View on Photon](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor(tier === 'High' ? '#ff0000' : '#00ffcc')
    .setFooter(`🚨 PumpFun Alert • ${new Date().toLocaleTimeString()}`)
    .setTimestamp();

  try {
    await webhookClient.send(embed);
    log(`✅ Sent ${baseToken.symbol} (${tier}) to Discord`);
  } catch (err) {
    log(`❌ Discord Error: ${err.message}`);
  }
}

function getTokenAgeMinutes(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / 60000;
}

async function checkTokens() {
  log(`🚀 [ROUND STARTED]`);

  const tokens = await fetchNewMoralisTokens();
  let goodCount = 0;

  await Promise.all(
    tokens.map((token) =>
      limit(async () => {
        const ca = token.tokenAddress;
        const fdv = Number(token.fullyDilutedValuation);
        const age = getTokenAgeMinutes(token.createdAt);

        if (fdv < 14690) {
          log(`⏩ Skipping ${ca} — FDV: $${fdv} < 14690`);
          return;
        }
        if (age > 20) {
          log(`⏩ Skipping ${ca} — Age: ${age.toFixed(2)} mins > 20`);
          return;
        }

        const details = await fetchDexscreenerDetails(ca);
        if (!details) {
          log(`❌ Skipped ${ca} — No DexScreener details`);
          return;
        }

        const mcap = details.marketCap ?? 0;
        const tokenCreatedAt = details.pairCreatedAt ?? token.createdAt;
        const ageMinutes = getTokenAgeMinutes(tokenCreatedAt);

        log(`🔍 Detected ${ca} — MCAP: $${mcap.toLocaleString()}, Age: ${ageMinutes.toFixed(1)} mins`);

        const tracked = trackedTokens.get(ca) || { midSent: false, highSent: false };

        const shouldSendMid = mcap >= 14690 && mcap < 69000 && ageMinutes <= 20 && !tracked.midSent;
        const shouldSendHigh = mcap >= 69000 && ageMinutes <= 120 && !tracked.highSent;

        if (shouldSendHigh) {
          await sendToDiscord(details, HIGH_TIER_WEBHOOK_CLIENT, 'High');
          tracked.highSent = true;
          goodCount++;
        } else if (shouldSendMid) {
          await sendToDiscord(details, MID_TIER_WEBHOOK_CLIENT, 'Mid');
          tracked.midSent = true;
          goodCount++;
        }

        trackedTokens.set(ca, tracked);
      })
    )
  );

  pollInterval = goodCount >= 2 ? 15000 : 30000;

  log(`✅ [ROUND ENDED] Checked ${tokens.length} tokens | Sent ${goodCount} tokens | Next poll: ${pollInterval / 1000}s`);
  scheduleNextPoll();
}

function scheduleNextPoll() {
  setTimeout(() => {
    checkTokens();
  }, pollInterval);
}

checkTokens();
