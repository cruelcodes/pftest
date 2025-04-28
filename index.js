// ✅ CHANGES:
// - sendToDiscord now takes "tier" (Mid/High) explicitly
// - graduated tokens must be <= 60 minutes old
// - removed webhookClient.url.includes error

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
const keysPerDay = [...MORALIS_KEYS];
const dailyKeyOrder = shuffleArray(keysPerDay);
const startOfDay = new Date().setHours(0, 0, 0, 0);

const LOG_FILE = 'tokens.log';
const trackedMidTier = new LRUCache({ max: 1000, ttl: 1000 * 60 * 120 }); // 2 hours
const trackedHighTier = new LRUCache({ max: 1000, ttl: 1000 * 60 * 120 });
const limit = pLimit(5);
let pollInterval = 30000;

const PUMP_DEXES = new Set(["pumpfun", "pumpswap"]);

function shuffleArray(arr) {
  return arr
    .map((v) => ({ v, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ v }) => v);
}

function getCurrentMoralisKey() {
  const now = Date.now();
  const hoursSinceMidnight = Math.floor((now - startOfDay) / 3600000);
  const index = Math.floor(hoursSinceMidnight / hoursPerBlock) % dailyKeyOrder.length;
  return dailyKeyOrder[index];
}

function log(message) {
  const formatted = `[${new Date().toISOString()}] ${message}`;
  console.log(formatted);
  fs.appendFileSync(LOG_FILE, formatted + '\n');
}

function getTokenAgeMinutes(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) / 60000;
}

async function fetchNewMoralisTokens() {
  try {
    const res = await fetch('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new?limit=100', {
      headers: {
        accept: 'application/json',
        'X-API-Key': getCurrentMoralisKey(),
      },
    });
    const data = await res.json();
    return data?.result || [];
  } catch (err) {
    log(`❌ Moralis Fetch Error: ${err.message}`);
    return [];
  }
}

async function fetchGraduatedTokens() {
  try {
    const res = await fetch('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated?limit=100', {
      headers: {
        accept: 'application/json',
        'X-API-Key': getCurrentMoralisKey(),
      },
    });
    const data = await res.json();
    return data?.result || [];
  } catch (err) {
    log(`❌ Graduated Tokens Fetch Error: ${err.message}`);
    return [];
  }
}

async function fetchDexscreenerDetails(tokenAddress) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`);
    return data?.[0] || null;
  } catch (err) {
    log(`❌ Dexscreener Fetch Error for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

async function sendToDiscord(token, webhookClient, tier, icon = '') {
  const { baseToken, marketCap, priceUsd, volume, txns, priceChange, url, pairAddress } = token;

  const embed = new MessageBuilder()
    .setTitle(`🚀 ${baseToken.name} ($${baseToken.symbol})`)
    .setURL(url)
    .setThumbnail(icon)
    .addField('💰 Market Cap', `$${(marketCap ?? 0).toLocaleString()}`, true)
    .addField('💸 Price', `$${priceUsd}`, true)
    .addField('📊 Volume (1h)', `${volume?.h1 ?? 0} SOL`, true)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys ?? 0}`, true)
    .addField('📈 Change (5m)', `${priceChange?.m5 ?? 0}%`, true)
    .addField('🔗 Photon', `[View](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor('#00ffcc')
    .setFooter(`🚨 PumpFun Alert • ${new Date().toLocaleTimeString()}`)
    .setTimestamp();

  try {
    await webhookClient.send(embed);
    log(`✅ Sent ${baseToken.symbol} to Discord (${tier})`);
  } catch (err) {
    log(`❌ Discord Webhook Error: ${err.message}`);
  }
}

async function sendToDiscordAlt(pair) {
  const { baseToken, dexId, priceUsd, txns, url, volume, priceChange, pairAddress } = pair;

  const embed = new MessageBuilder()
    .setTitle(`${baseToken.symbol} listed on ${dexId.toUpperCase()}`)
    .setURL(url)
    .addField('💵 Price', `$${parseFloat(priceUsd).toFixed(6)}`, true)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys ?? 0}`, true)
    .addField('🧯 Sells (5m)', `${txns?.m5?.sells ?? 0}`, true)
    .addField('📊 Volume (5m)', `$${Math.round(volume?.m5 ?? 0)}`, true)
    .addField('📉 Change (5m)', `${priceChange?.m5 ?? 0}%`, true)
    .addField('🔗 Photon', `[View](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor('#00b0f4')
    .setTimestamp();

  try {
    await MID_TIER_WEBHOOK_CLIENT.send(embed);
    log(`✅ Sent non-pump token ${baseToken.symbol} (${dexId})`);
  } catch (err) {
    log(`❌ Discord Non-pump Error: ${err.message}`);
  }
}

async function checkTokens() {
  log(`🚀 [CHECK ROUND STARTED]`);

  const tokens = await fetchNewMoralisTokens();
  let goodTokens = 0;

  await Promise.all(tokens.map((token) =>
    limit(async () => {
      const ca = token.tokenAddress;
      const fdv = Number(token.fullyDilutedValuation);
      const age = getTokenAgeMinutes(token.createdAt);

      if (fdv < 16900) return log(`⏩ Skipped ${ca} — FDV: $${fdv} < 16900`);
      if (age > 20) return log(`⏩ Skipped ${ca} — Age: ${age.toFixed(1)} mins > 20`);

      const details = await fetchDexscreenerDetails(ca);
      if (!details) return;

      const mcap = details.marketCap ?? 0;
      const realAge = getTokenAgeMinutes(details.pairCreatedAt ?? token.createdAt);

      log(`🔍 ${ca} — mcap: $${mcap}, age: ${realAge.toFixed(1)} mins`);

      const shouldMid = mcap >= 16900 && mcap < 80000 && realAge <= 20;
      const shouldHigh = mcap >= 80000 && realAge <= 120;

      if (shouldMid && !trackedMidTier.has(ca)) {
        await sendToDiscord(details, MID_TIER_WEBHOOK_CLIENT, 'Mid');
        trackedMidTier.set(ca, Date.now());
        goodTokens++;
      }

      if (shouldHigh && !trackedHighTier.has(ca)) {
        await sendToDiscord(details, HIGH_TIER_WEBHOOK_CLIENT, 'High');
        trackedHighTier.set(ca, Date.now());
        goodTokens++;
      }
    })
  ));

  pollInterval = goodTokens >= 2 ? 15000 : 30000;
  log(`✅ [ROUND ENDED] Tokens checked: ${tokens.length} | Sent: ${goodTokens} | Next poll: ${pollInterval / 1000}s`);
}

async function fetchLatestTokenProfiles() {
  try {
    const res = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
    return res.data || [];
  } catch (err) {
    log(`❌ Token Profiles Fetch Error: ${err.message}`);
    return [];
  }
}

async function fetchTokenPairs(tokenAddress) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/token-pairs/v1/solana/${tokenAddress}`);
    return res.data || [];
  } catch (err) {
    log(`❌ Token Pairs Fetch Error for ${tokenAddress}: ${err.message}`);
    return [];
  }
}

async function checkOtherDexTokens() {
  const profiles = await fetchLatestTokenProfiles();

  await Promise.all(profiles.map((profile) =>
    limit(async () => {
      const tokenAddress = profile.tokenAddress;
      if (trackedMidTier.has(tokenAddress) || trackedHighTier.has(tokenAddress)) return;

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
          break;
        }
      }
    })
  ));
}

async function recheckForHighTier() {
  const tokens = Array.from(trackedMidTier.keys());

  await Promise.all(tokens.map((ca) =>
    limit(async () => {
      const details = await fetchDexscreenerDetails(ca);
      if (!details) return;

      const mcap = details.marketCap ?? 0;
      const age = getTokenAgeMinutes(details.pairCreatedAt);

      if (mcap >= 69000 && age <= 120 && !trackedHighTier.has(ca)) {
        await sendToDiscord(details, HIGH_TIER_WEBHOOK_CLIENT, 'High');
        trackedHighTier.set(ca, Date.now());
        log(`🔥 Promoted ${ca} to HIGH-TIER — mcap: $${mcap}`);
      }
    })
  ));
}

async function checkGraduatedTokens() {
  const tokens = await fetchGraduatedTokens();

  await Promise.all(tokens.map((token) =>
    limit(async () => {
      const ca = token.tokenAddress;
      const fdv = Number(token.fullyDilutedValuation) || 0;
      const age = getTokenAgeMinutes(token.createdAt);

      if (fdv >= 69000 && age <= 60 && !trackedHighTier.has(ca)) { // ✅ only < 1 hr old
        const details = await fetchDexscreenerDetails(ca);
        if (!details) return;

        await sendToDiscord(details, HIGH_TIER_WEBHOOK_CLIENT, 'High');
        trackedHighTier.set(ca, Date.now());
        log(`🎓 Sent Graduated Token ${ca} to HIGH-TIER — FDV: $${fdv}`);
      }
    })
  ));
}

function scheduleNextPoll() {
  setTimeout(async () => {
    await checkTokens();
    await checkOtherDexTokens();
    await recheckForHighTier();
    await checkGraduatedTokens();
    scheduleNextPoll();
  }, pollInterval);
}

// START
checkTokens();
scheduleNextPoll();
