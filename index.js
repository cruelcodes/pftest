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

// -------- FETCH FUNCTIONS --------

async function fetchPumpfunTokens() {
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
    log(`❌ Pumpfun Fetch Error: ${err.message}`);
    return [];
  }
}

async function fetchRaydiumPairs() {
  try {
    const res = await axios.get('https://api.raydium.io/v2/main/pairs');
    return res.data?.official ?? [];
  } catch (err) {
    log(`❌ Raydium Fetch Error: ${err.message}`);
    return [];
  }
}

// -------- SEND TO DISCORD --------

async function sendToDiscord(token, webhookClient, icon = '', source = 'Pumpfun') {
  const { baseToken, marketCap, priceUsd, volume, txns, priceChange, url, pairAddress } = token;

  const embed = new MessageBuilder()
    .setTitle(`🚀 ${baseToken.name} ($${baseToken.symbol})`)
    .setURL(url)
    .setThumbnail(icon)
    .addField('💰 Market Cap', `$${(marketCap ?? 0).toLocaleString()}`, true)
    .addField('💸 Price', `$${parseFloat(priceUsd).toFixed(6)}`, true)
    .addField('📊 Volume (1h)', `${volume?.h1 ?? 0} SOL`, true)
    .addField('🛒 Buys (5m)', `${txns?.m5?.buys ?? 0}`, true)
    .addField('📈 Change (5m)', `${priceChange?.m5 ?? 0}%`, true)
    .addField('🔗 Photon', `[View](https://photon-sol.tinyastro.io/en/lp/${pairAddress})`, true)
    .addField('📜 Contract', `\`${baseToken.address}\``, false)
    .setColor(source === 'Pumpfun' ? '#00ffcc' : '#ffb347')
    .setFooter(`🚨 ${source} Alert • ${new Date().toLocaleTimeString()}`)
    .setTimestamp();

  try {
    await webhookClient.send(embed);
    log(`✅ Sent ${baseToken.symbol} to Discord (${source})`);
  } catch (err) {
    log(`❌ Discord Send Error: ${err.message}`);
  }
}

// -------- CHECKER FUNCTIONS --------

async function checkPumpfunTokens() {
  const tokens = await fetchPumpfunTokens();
  let goodTokens = 0;

  await Promise.all(tokens.map((token) =>
    limit(async () => {
      const ca = token.tokenAddress;
      const fdv = Number(token.fullyDilutedValuation);
      const age = getTokenAgeMinutes(token.createdAt);

      if (fdv < 16900 || age > 20) return;

      try {
        const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${ca}`);
        const pair = data?.[0];
        if (!pair) return;

        const mcap = pair.marketCap ?? 0;
        const realAge = getTokenAgeMinutes(pair.pairCreatedAt ?? token.createdAt);

        const shouldMid = mcap >= 16900 && mcap < 80000 && realAge <= 20;
        const shouldHigh = mcap >= 80000 && realAge <= 120;

        if (shouldMid && !trackedMidTier.has(ca)) {
          await sendToDiscord(pair, MID_TIER_WEBHOOK_CLIENT, '', 'Pumpfun');
          trackedMidTier.set(ca, Date.now());
          goodTokens++;
        }

        if (shouldHigh && !trackedHighTier.has(ca)) {
          await sendToDiscord(pair, HIGH_TIER_WEBHOOK_CLIENT, '', 'Pumpfun');
          trackedHighTier.set(ca, Date.now());
          goodTokens++;
        }
      } catch (err) {
        log(`❌ Dexscreener Fetch Error for Pumpfun ${ca}: ${err.message}`);
      }
    })
  ));

  pollInterval = goodTokens >= 2 ? 15000 : 30000;
}

async function checkRaydiumTokens() {
  const pairs = await fetchRaydiumPairs();

  await Promise.all(pairs.map((pair) =>
    limit(async () => {
      const { marketInfo, baseMint, name, symbol, marketCap, createdAt, price, volume24hQuote } = pair;
      const ca = baseMint;
      const age = getTokenAgeMinutes(createdAt);

      if (marketCap < 16900 || age > 20) return;
      if (trackedMidTier.has(ca) || trackedHighTier.has(ca)) return;

      const fakeDexscreenerData = {
        baseToken: {
          name,
          symbol,
          address: ca,
        },
        marketCap,
        priceUsd: price,
        volume: { h1: (volume24hQuote ?? 0) / 24 },
        txns: { m5: { buys: 0 } }, // Raydium doesn't provide buys directly
        priceChange: { m5: 0 },
        url: `https://dexscreener.com/solana/${marketInfo}`,
        pairAddress: marketInfo,
      };

      const shouldMid = marketCap >= 16900 && marketCap < 80000;
      const shouldHigh = marketCap >= 80000;

      if (shouldMid) {
        await sendToDiscord(fakeDexscreenerData, MID_TIER_WEBHOOK_CLIENT, '', 'Raydium');
        trackedMidTier.set(ca, Date.now());
      }

      if (shouldHigh) {
        await sendToDiscord(fakeDexscreenerData, HIGH_TIER_WEBHOOK_CLIENT, '', 'Raydium');
        trackedHighTier.set(ca, Date.now());
      }
    })
  ));
}

// -------- MAIN POLLER --------

function scheduleNextPoll() {
  setTimeout(async () => {
    log(`🚀 [POLL START]`);
    await checkPumpfunTokens();
    await checkRaydiumTokens();
    log(`✅ [POLL DONE] Next poll in ${pollInterval / 1000}s`);
    scheduleNextPoll();
  }, pollInterval);
}

// START
checkPumpfunTokens();
checkRaydiumTokens();
scheduleNextPoll();
