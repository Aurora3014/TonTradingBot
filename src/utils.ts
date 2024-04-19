import { encodeTelegramUrlParameters, isTelegramUrl, WalletInfoRemote } from '@tonconnect/sdk';
import { InlineKeyboardButton, Message } from 'node-telegram-bot-api';
import { bot } from './bot';
import { fetchPrice, Jetton } from './dedust/api';
import axios from 'axios';
import { AltToken, createAltToken, getAltTokenWithAddress, getPoolWithCaption, Pool } from './ton-connect/mongo';
import mongoose from 'mongoose';

export const AT_WALLET_APP_NAME = 'telegram-wallet';

export const pTimeoutException = Symbol();

export function pTimeout<T>(
    promise: Promise<T>,
    time: number,
    exception: unknown = pTimeoutException
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise((_r, rej) => (timer = setTimeout(rej, time, exception)))
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
}
export async function delay(MS: number): Promise<any> {
    return new Promise(resolve => {
        return setTimeout(resolve, MS);
    });
}
export function addTGReturnStrategy(link: string, strategy: string): string {
    const parsed = new URL(link);
    parsed.searchParams.append('ret', strategy);
    link = parsed.toString();

    const lastParam = link.slice(link.lastIndexOf('&') + 1);
    return link.slice(0, link.lastIndexOf('&')) + '-' + encodeTelegramUrlParameters(lastParam);
}

export function convertDeeplinkToUniversalLink(link: string, walletUniversalLink: string): string {
    const search = new URL(link).search;
    const url = new URL(walletUniversalLink);

    if (isTelegramUrl(walletUniversalLink)) {
        const startattach = 'tonconnect-' + encodeTelegramUrlParameters(search.slice(1));
        url.searchParams.append('startattach', startattach);
    } else {
        url.search = search;
    }

    return url.toString();
}
//eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function fetchDataGet(fetchURL: String, dex: String): Promise<any> {
    let initString = '';
    if (dex === 'dedust') initString = 'https://api.dedust.io/v2';
    else if (dex === 'ston') initString = 'https://api.ston.fi/v1';
    else initString = 'https://api.dedust.io/v2';
    try {
        const response = await axios.get(initString + fetchURL, {
            headers: {
                accept: 'application/json'
            },
            timeout: 100000000
        });
        console.log('Fetch Success => ' + fetchURL); // Output the response data
        if (dex === 'ston') {
            if (fetchURL === '/assets') {
                const assetSton: any[] = response.data['asset_list'];
                assetSton.map(assetStonOne => {
                    assetStonOne.type = assetStonOne.kind;
                    assetStonOne.address = assetStonOne.contract_address;
                    assetStonOne.name = assetStonOne.display_name;
                    assetStonOne.symbol = assetStonOne.symbol;
                    assetStonOne.image = assetStonOne.image_url;
                    assetStonOne.decimals = assetStonOne.decimals;
                    assetStonOne.riskScore = '0';
                });

                return assetSton!;
            }
            const assetSton: any[] = response.data['pool_list'];
            assetSton.filter(
                singleAsset =>
                    singleAsset.token0_address ===
                        'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' ||
                    singleAsset.token1_address ===
                        'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'
            );
            assetSton.map(assetStonOne => {
                assetStonOne.caption = ['', ''];
                assetStonOne.address = assetStonOne.address;
                assetStonOne.lt = assetStonOne.lp_total_supply;
                assetStonOne.totalSupply = Number(assetStonOne.lp_total_supply);
                assetStonOne.type = 'ston';
                assetStonOne.tradeFee = Number(assetStonOne.lp_fee);
                assetStonOne.prices = [0, 0];
                assetStonOne.assets = [assetStonOne.token0_address, assetStonOne.token1_address];
                assetStonOne.reserves = [
                    Number(assetStonOne.reserve0),
                    Number(assetStonOne.reserve1)
                ];
                assetStonOne.fees = [Number(assetStonOne.reserve0), Number(assetStonOne.reserve1)];
                assetStonOne.volume = [BigInt(0), BigInt(0)];
                assetStonOne.decimals = [0, 0];
                assetStonOne.TVL = Number(assetStonOne.lp_total_supply_usd);
                assetStonOne.main =
                    assetStonOne.token0_address ===
                    'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'
                        ? 0
                        : 1;
                assetStonOne.dex = 'ston';
                assetStonOne.assets = [assetStonOne.token0_address, assetStonOne.token1_address]
            })
            return assetSton!;
        } else {
            if (fetchURL === '/pools') {
                let pools: any[] = response.data;
                pools = pools.filter(pool => {
                    if (Number(pool.totalSupply) >= 100000000) {
                        return true;
                    } else {
                        return false;
                    }
                });
                pools.filter(async pool => {
                    let temp: any = pool.assets;
                    pool.assets = ['', ''];
                    pool.caption = ['', ''];
                    pool.prices = [0, 0];
                    pool.TVL = 0;
                    pool.decimals = [0, 0];
                    pool.dex = 'dedust';
                    for (let k = 0; k < 2; k++) {
                        try {
                            pool.caption[k] = temp[k].metadata.symbol ?? '';
                            pool.decimals[k] = temp[k].metadata.decimals ?? 9;
                        } catch (error) {
                            
                            pool.caption[k] = temp[k].address;
                            pool.decimals[k] = 0;
                        }
                        pool.assets[k] = !!!temp[k].address ? 'native' : temp[k].address;
                        //console.log(pool.assets[k]); address output
                    }
                });
                return pools;
            } else return response.data;
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        delay(500)
        console.error('retry');
        return await fetchDataGet(fetchURL, dex);
    }
}
export async function buildUniversalKeyboard(
    link: string,
    wallets: WalletInfoRemote[]
): Promise<InlineKeyboardButton[]> {
    const atWallet = wallets.find(wallet => wallet.appName.toLowerCase() === AT_WALLET_APP_NAME);
    const atWalletLink = atWallet
        ? addTGReturnStrategy(
              convertDeeplinkToUniversalLink(link, atWallet?.universalLink),
              process.env.TELEGRAM_BOT_LINK!
          )
        : undefined;
    const keyboard = [
        {
            text: 'Choose a Wallet',
            callback_data: JSON.stringify({ method: 'chose_wallet' })
        },
        {
            text: 'Open Link',
            url: `https://194.163.169.41/open-tc?connect=${encodeURIComponent(link)}`
        }
    ];

    if (atWalletLink) {
        keyboard.unshift({
            text: '@wallet',
            url: atWalletLink
        });
    }

    return keyboard;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function replyMessage(
    msg: Message,
    text: string,
    inlineButtons?: InlineKeyboardButton[][]
) {
    await bot
        .editMessageCaption(text, {
            message_id: msg.message_id,
            chat_id: msg.chat.id,
            parse_mode: 'HTML'
        })
        .then(() => {})
        .catch(async () => {
            await bot.editMessageText(text, {
                message_id: msg.message_id,
                chat_id: msg.chat.id,
                parse_mode: 'HTML'
            });
        });
    if (inlineButtons !== undefined)
        await bot.editMessageReplyMarkup(
            { inline_keyboard: inlineButtons! },
            {
                message_id: msg.message_id,
                chat_id: msg.chat.id
            }
        );
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function getPriceStr(jettons: string[], mainId: number, dex: string) {
    // eslint-disable-next-line unused-imports/no-unused-vars
    // let assets: Jetton[] = await fetchDataGet('/assets', dex);
    let addresses = ['', ''];
    let decimals = [0, 0]

    const pool = await getPoolWithCaption(jettons, dex);
    addresses = pool?.assets!;
    decimals = pool?.decimals!;
    console.log('decimals', decimals, pool, jettons)

    if (decimals[1 - mainId] === 0) {
        let metadata = await getAltTokenWithAddress(addresses[1 - mainId]!, 'dedust');
        decimals[1-mainId] = Number(metadata!.decimals);
        console.log(metadata);
    }
    if (decimals[1 - mainId] == undefined) {
        return 0;
    }
    console.log(decimals);
    let price: number = await fetchPrice(
        10 ** decimals[1 - mainId]!,
        addresses[1 - mainId]!,
        addresses[mainId]!,
        dex
    );
    price /= 10 ** decimals[mainId]!;
    const strPrice = price.toFixed(9);
    // console.log(strPrice, addresses)
    return strPrice;
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function altTokenTableUpdate(dex: string){
    if (dex === 'dedust') {
        let pools: any[] = ( await axios.get('https://api.dedust.io/v2/pools', {
            headers: {
                accept: 'application/json'
            },
            timeout: 100000000
        })).data;
        for (const pool of pools) {
            for (let i = 0; i < 2; i++) {
                if (pool.assets[i]?.type !== 'native') {
                    const altToken = await getAltTokenWithAddress(String(pool.assets[i]!.address), dex);
                    if (!!!altToken) {
                    console.log(pool.assets[i].address);
                    try {
                        let metadata = pool.assets[i].metadata;
                        if (!!!metadata) {
                            metadata = ( await axios.get(
                                `https://api.dedust.io/v2/jettons/${pool.assets[i].address}/metadata`, {
                                    headers: {
                                        accept: 'application/json'
                                    },
                                    timeout: 100000000
                                }) ) .data;
                        }
                        metadata.dex = 'dedust';
                        metadata.address = pool.assets[i].address;
                        console.log(await createAltToken(metadata));
 
                        console.log('success')
                        } catch (error) {
                            console.log(error)
                        }
                    }
                }
            }
        };
    } else if (dex == 'ston') {
        try {
            let assets: any[] = ( await axios.get('https://api.ston.fi/v1/assets', {
                headers: {
                    accept: 'application/json'
                },
                timeout: 100000000
            })).data.asset_list;
            console.log(assets)
            for (const asset of assets) {
                const altTokenDB = await getAltTokenWithAddress(asset.contract_address, dex);
                if (!!!altTokenDB){
                    let altToken: any = {
                        address: asset.address,
                        symbol: asset.symbol,
                        name: asset.display_name,
                        decimals: asset.decimals,
                        image: asset.image_url,
                        dex
                    }
                    console.log(await createAltToken(altToken));
                }
            }
        } catch (error) {
            console.log(error)
        }
        
    }
}
