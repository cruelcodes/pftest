// Dependencies: npm install node-fetch axios p-limit lru-cache dotenv discord-webhook-node
import 'dotenv/config';
import fetch from 'node-fetch';
import axios from 'axios';
import fs from 'fs';
import { LRUCache } from 'lru-cache';
import pLimit from 'p-limit';
import { Webhook, MessageBuilder } from 'discord-webhook-node';

// ========== CONFIG ========== //
const MORALIS_KEYS = safeParseJson(process.env.MORALIS_KEYS) || [];
const MID_TIER_WEBHOOK = process.env.MID_TIER_WEBHOOK || '';
const HIGH_TIER_WEBHOOK = process.env.HIGH_TIER_WEBHOOK || '';

if (!MORALIS_KEYS.length || !MID_TIER_WEBHOOK || !HIGH_TIER_WEBHOOK) {
  console.error('❌ Missing .env configs. Exiting...');
  process.exit(1);
}

const MID_TIER_WEBHOOK_CLIENT = new Webhook(MID_TIER_WEBHOOK);
const HIGH_TIER_WEBHOOK_CLIENT = new Webhook(HIGH_TIER_WEBHOOK);

const hoursPerBlock = 6;
const keysPerDay = [...MORALIS_KEYS];
const dailyKeyOrder = shuffleArray(keysPerDay);
const startOfDay = new Date().setHours(0, 0, 0, 0);

const LOG_FILE = 'tokens.log';
const limit = pLimit(5);
const trackedMidTier = new LRUCache({ max: 1000, ttl: 1000 * 60 * 20 }); // 20 min
const trackedHighTier = new LRUCache({ max: 1000, ttl: 1000 * 60 * 120 }); // 2 hours
const PUMP_DEXES = new Set(['pumpfun', 'pumpswap']);

let pollInterval = 30000;
let isRunning = false;

// ========== HELPERS ========== //

function log(message) {
  const text = `[${new Date().toISOString()}] ${message}`;
  console.log(text);
  fs.appendFileSync(LOG_FILE, text + '\n');
}

function safeParseJson(jsonStr) {
  try { return JSON.parse(jsonStr); } 
  catch { return null; }
}

function shuffleArray(arr) {
  return arr.map(val => ({ val, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ val }) => val);
}

function getCurrentMoralisKey() {
  const now = Date.now();
  const hoursSinceMidnight = Math.floor((now - startOfDay) / 3600000);
  const index = Math.floor(hoursSinceMidnight / hoursPerBlock) % dailyKeyOrder.length;
  return dailyKeyOrder[index];
}

function getTokenAgeMinutes(date) {
  return (Date.now() - new Date(date).getTime()) / 60000;
}

async function retry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ========== FETCHERS ========== //

async function fetchNewMoralisTokens() {
  return retry(async () => {
    const res = await fetch('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new?limit=100', {
      method: 'GET',
      headers: { accept: 'application/json', 'X-API-Key': getCurrentMoralisKey() },
    });
    const data = await res.json();
    return data?.result || [];
  }).catch(err => {
    log(`❌ Moralis Fetch Error: ${err.message}`);
    return [];
  });
}

async function fetchDexscreenerDetails(tokenAddress) {
  return retry(async () => {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`);
    return data?.[0] || null;
  }).catch(err => {
    log(`❌ Dexscreener Fetch Error: ${err.message}`);
    return null;
  });
}

async function fetchLatestTokenProfiles() {
  return retry(async () => {
    const { data } = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    return data || [];
  }).catch(err => {
    log(`❌ Token Profiles Fetch Error: ${err.message}`);
    return [];
  });
}

async function fetchTokenPairs(tokenAddress) {
  return retry(async () => {
    const { data } = await axios.get(`https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`);
    return data || [];
  }).catch(err => {
    log(`❌ Token Pairs Fetch Error (${tokenAddress}): ${err.message}`);
    return [];
  });
}

// ========== DISCORD SENDERS ========== //

async function sendToDiscord(details, webhookClient, icon = '') {
  const { baseToken, marketCap, priceUsd, volume, txns, priceChange, url, pairAddress } = details;

  const embed = new MessageBuilder()
    .setTitle(`🚀 ${baseToken.name} ($${baseToken.symbol})`)
    .setURL(url)
    .setThumbnail(icon)
    .addField('💰 Market Cap', `$${(marketCap ?? 0).toLocaleString()}`, true)
    .addField('💸 Price', `$${priceUsd}`, true)
    .addField('📊 Volume (1h)', `${volume?.h1 ?? 0} SOL`, true)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys ?? 0}`, true)
    .addField('📈 Change (5m)', `${priceChange?.m5 ?? 0}%`, true)
    .addField('🔗 Photon', `[View on Photon](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor('#00ffcc')
    .setFooter(`🚨 PumpFun Alert • ${new Date().toLocaleTimeString()}`)
    .setTimestamp();

  await webhookClient.send(embed);
}

async function sendToDiscordAlt(pair) {
  const { baseToken, dexId, priceUsd, txns, url, volume, priceChange } = pair;

  const embed = new MessageBuilder()
    .setTitle(`${baseToken.symbol} listed on ${dexId.toUpperCase()}`)
    .setURL(url)
    .setDescription(`**${baseToken.name}** (${baseToken.symbol})\n\n💵 Price: **$${parseFloat(priceUsd).toFixed(6)}**`)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys || 0}`, true)
    .addField('🧯 Sells (5m)', `${txns?.m5?.sells || 0}`, true)
    .addField('📊 Volume (5m)', `$${Math.round(volume?.m5 || 0)}`, true)
    .addField('📉 Price Change (5m)', `${priceChange?.m5 || 0}%`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor('#00b0f4')
    .setTimestamp();

  await MID_TIER_WEBHOOK_CLIENT.send(embed);
}

// ========== CHECKERS ========== //

async function checkPumpTokens() {
  log(`🚀 [ROUND STARTED: PumpFun]`);
  const tokens = await fetchNewMoralisTokens();
  let sentCount = 0;

  await Promise.all(tokens.map(token => limit(async () => {
    const ca = token.tokenAddress;
    const fdv = Number(token.fullyDilutedValuation);
    const age = getTokenAgeMinutes(token.createdAt);

    if (fdv < 16900 || age > 20) return;

    const details = await fetchDexscreenerDetails(ca);
    if (!details) return;

    const mcap = details.marketCap ?? 0;
    const tokenCreatedAt = details.pairCreatedAt ?? token.createdAt;
    const ageMinutes = getTokenAgeMinutes(tokenCreatedAt);

    const shouldSendMid = mcap >= 16900 && mcap < 80000 && ageMinutes <= 20;
    const shouldSendHigh = mcap >= 80000 && ageMinutes <= 120;

    if (shouldSendMid && !trackedMidTier.has(ca)) {
      await sendToDiscord(details, MID_TIER_WEBHOOK_CLIENT);
      trackedMidTier.set(ca, Date.now());
      sentCount++;
    }

    if (shouldSendHigh && !trackedHighTier.has(ca)) {
      await sendToDiscord(details, HIGH_TIER_WEBHOOK_CLIENT);
      trackedHighTier.set(ca, Date.now());
      sentCount++;
    }
  })));

  log(`✅ [ROUND ENDED] Pump Tokens: ${tokens.length} checked | ${sentCount} sent`);
  return sentCount;
}

async function checkOtherDexTokens() {
  log(`🚀 [ROUND STARTED: Other Dex]`);
  const profiles = await fetchLatestTokenProfiles();
  let sentCount = 0;

  for (const profile of profiles) {
    const tokenAddress = profile.tokenAddress;
    if (trackedMidTier.has(tokenAddress) || trackedHighTier.has(tokenAddress)) continue;

    const pairs = await fetchTokenPairs(tokenAddress);
    for (const pair of pairs) {
      const { dexId, txns, volume, fdv, pairCreatedAt } = pair;
      if (PUMP_DEXES.has(dexId)) continue;

      const ageMinutes = getTokenAgeMinutes(pairCreatedAt);
      const buys5m = txns?.m5?.buys ?? 0;
      const volume5m = volume?.m5 ?? 0;
      const fdvValue = Number(fdv) || 0;

      if (fdvValue >= 16900 && buys5m >= 5 && volume5m >= 500 && ageMinutes <= 20) {
        await sendToDiscordAlt(pair);
        trackedMidTier.set(tokenAddress, Date.now());
        sentCount++;
        break;
      }
    }
  }

  log(`✅ [ROUND ENDED] Non-Pump Tokens: ${sentCount} sent`);
  return sentCount;
}

// ========== MAIN LOOP ========== //

async function mainLoop() {
  if (isRunning) return;
  isRunning = true;

  try {
    const pumpSent = await checkPumpTokens();
    const otherSent = await checkOtherDexTokens();

    const totalSent = pumpSent + otherSent;
    pollInterval = totalSent >= 2 ? 15000 : 30000;
  } catch (err) {
    log(`❌ Main loop error: ${err.message}`);
  } finally {
    isRunning = false;
    setTimeout(mainLoop, pollInterval);
  }
}

mainLoop();
